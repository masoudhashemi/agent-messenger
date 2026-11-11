import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { Workspace } from "../src/workspace.js";
import { PythonSandbox } from "../src/sandbox.js";
import { Harness } from "../src/harness.js";
import { commandArguments } from "../public/commands.js";

test("uv commands parse argv without shell expansion", () => {
  assert.deepEqual(commandArguments("python -c \"print('hello world')\""), [
    "python",
    "-c",
    "print('hello world')",
  ]);
  assert.deepEqual(commandArguments("python '$HOME' '$(whoami)'"), [
    "python",
    "$HOME",
    "$(whoami)",
  ]);
  assert.deepEqual(commandArguments('python ""'), ["python", ""]);
  assert.throws(() => commandArguments('python "unfinished'), /quoted/);
});

test("uv settings are project-local, persisted, operator validated, and locked during execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-uv-settings-"));
  const a = new Store(),
    b = new Store();
  try {
    const wa = new Workspace(a, {
        root: join(dir, "a"),
        gitDir: join(dir, "a.git"),
      }),
      wb = new Workspace(b, {
        root: join(dir, "b"),
        gitDir: join(dir, "b.git"),
      });
    assert.deepEqual(wa.environment(), {
      use_uv: false,
      allow_package_install: false,
    });
    wa.configureEnvironment({ use_uv: true, allow_package_install: false });
    assert.equal(
      new Workspace(a, {
        root: wa.root,
        gitDir: wa.folder.gitDir,
      }).environment().use_uv,
      true,
    );
    assert.equal(wb.environment().use_uv, false);
    const sandbox = new PythonSandbox(wa);
    await assert.rejects(() => sandbox.uv("sync"), /disabled by the operator/);
    await assert.rejects(() => sandbox.uv("run", []), /arguments/);
    await assert.rejects(() => sandbox.uv("init", ["--network"]), /arguments/);
    wa.locked = true;
    assert.throws(
      () =>
        wa.configureEnvironment({
          use_uv: false,
          allow_package_install: false,
        }),
      /Wait/,
    );
  } finally {
    a.db.close();
    b.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed environments and caches are excluded from scans and force-add Git commits", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-uv-excludes-"));
  const s = new Store();
  try {
    const w = new Workspace(s, {
      root: join(dir, "source"),
      gitDir: join(dir, "history.git"),
    });
    for (const folder of [".venv/lib", ".uv-cache/wheels", ".pytest_cache/v"]) {
      mkdirSync(join(w.root, folder), { recursive: true });
      writeFileSync(join(w.root, folder, "hidden.txt"), "package content");
    }
    // Simulate an accidental force-add by an external tool; the next commit removes it.
    execFileSync("git", ["-C", w.root, "add", "-f", ".venv/lib/hidden.txt"]);
    w.write("pyproject.toml", '[project]\nname="example"\n', 0);
    assert.equal(w.list().length, 1);
    assert.equal(w.directories().length, 0);
    assert.equal(
      execFileSync("git", ["-C", w.root, "ls-files"], {
        encoding: "utf8",
      }).trim(),
      "pyproject.toml",
    );
    assert.throws(() => w.write(".venv/secret", "bad", 0), /relative/);
    assert.equal(w.history()[0].changes.length, 1);
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness routes uv actions with agent attribution and environment context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-uv-tools-"));
  const s = new Store();
  try {
    const w = new Workspace(s, {
      root: join(dir, "source"),
      gitDir: join(dir, "git"),
    });
    w.configureEnvironment({ use_uv: true, allow_package_install: false });
    const agent = s.createAgent("Runner", "Run tests");
    const calls = [];
    const h = new Harness(
      s,
      () => {},
      async (messages) => {
        assert.equal(
          JSON.parse(messages[1].content).coding.environment.use_uv,
          true,
        );
        return JSON.stringify({
          working_note: {
            name: "Testing",
            body: "Create and inspect the environment.",
          },
          actions: [
            { type: "uv_venv" },
            { type: "uv_run", args: ["python", "--version"] },
            { type: "finish" },
          ],
        });
      },
      {
        workspace: w,
        sandbox: {
          uv: async (...args) => {
            calls.push(args);
            return { status: "succeeded" };
          },
        },
      },
    );
    h.start([agent.id], "Use project environment", 1);
    while (h.run.status === "running")
      await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["venv", "run"],
    );
    assert.equal(calls[1][3], agent.id);
    assert.equal(h.history[0].status, "ok");
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package gateway accepts only fixed package paths and rejects arbitrary destinations", () => {
  execFileSync("python3", [
    "-I",
    "-B",
    "-c",
    `import importlib.util, io
spec=importlib.util.spec_from_file_location('proxy',${JSON.stringify(join(process.cwd(), "docker/uv/package_proxy.py"))})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.upstream('/simple/idna/') == ('pypi.org','/simple/idna/')
assert m.upstream('/files/packages/aa/bb/pkg.whl') == ('files.pythonhosted.org','/packages/aa/bb/pkg.whl')
for p in ['https://example.com/', '//example.com/', '/simple/idna/?url=http://localhost', '/files/packages/../private', '/files/packages/%2e%2e/private', '/admin', 'localhost:443']:
 try: m.upstream(p)
 except ValueError: pass
 else: raise AssertionError('Allowed: '+p)

class FakeResponse:
 def __init__(self, body, length=None, status=200):
  self._buf = io.BytesIO(body)
  self._length = length
  self.status = status
 def getheader(self, name, default=None):
  if name == 'Content-Length': return self._length
  return default
 def read(self, n=-1): return self._buf.read(n)

class FakeConn:
 def __init__(self, resp): self.resp = resp
 def request(self, *a, **kw): pass
 def getresponse(self): return self.resp
 def close(self): pass

def run_request(path, resp):
 m.PublicHTTPS = lambda host, timeout=25: FakeConn(resp)
 raw = f"GET {path} HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n".encode()
 rfile, wfile = io.BytesIO(raw), io.BytesIO()
 class H(m.Handler):
  def __init__(self):
   self.rfile, self.wfile = rfile, wfile
   self.client_address = ('127.0.0.1', 0)
   self.server = type('S', (), {'server_name': 'test', 'server_port': 80})()
   self.handle_one_request()
 H()
 return wfile.getvalue()

out = run_request('/simple/idna/', FakeResponse(b'<a href="https://files.pythonhosted.org/packages/a.whl">a</a>', None))
assert b'200 OK' in out and b'http://127.0.0.1:8123/files/packages/a.whl' in out
m.MAX_TOTAL = 10
out_over = run_request('/simple/idna/', FakeResponse(b'0123456789abcdef', None))
assert b'413' in out_over
`,
  ]);
});
