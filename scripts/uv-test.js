import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Projects } from "../src/projects.js";
const dir = mkdtempSync(join(tmpdir(), "relay-uv-test-"));
let projects = new Projects(join(dir, "metadata"));
try {
  const pa = projects.create("uv A"),
    pb = projects.create("uv B");
  const { workspace: a, sandbox: sa, store } = projects.get(pa.id);
  const { workspace: b, sandbox: sb } = projects.get(pb.id);
  const actor = store.createAgent("Dependency tester", "Test uv");
  await assert.rejects(() => sa.uv("venv"), /Enable Use uv/);
  a.configureEnvironment({ use_uv: true, allow_package_install: true });
  b.configureEnvironment({ use_uv: true, allow_package_install: false });
  assert.equal((await sa.status()).ready, true, "Run npm run setup:uv first");
  let result = await sa.uv("init", [], 20, actor.id);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  a.write(
    "pyproject.toml",
    '[project]\nname = "relay-uv-test"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = ["idna==3.10", "pytest==8.3.5"]\n',
    a.read("pyproject.toml").revision,
    actor.id,
  );
  console.log(
    "Installing pinned test dependencies through the package gateway…",
  );
  const pending = sa.uv("sync", [], 180, actor.id);
  assert.throws(() => a.write("blocked.py", "no", 0), /busy/);
  result = await pending;
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.ok(existsSync(join(a.root, ".venv", "pyvenv.cfg")));
  assert.ok(a.read("uv.lock").content.includes("https://pypi.org/simple"));
  assert.ok(!a.read("uv.lock").content.includes("127.0.0.1"));
  a.write(
    "test_environment.py",
    `import idna, os, socket, sys, urllib.request
from pathlib import Path

def test_environment():
    assert sys.prefix == '/workspace/.venv'
    assert idna.__version__ == '3.10'
    assert 'TOOLKIT_TOKEN' not in os.environ
    assert not Path('/var/run/docker.sock').exists()
    assert not Path(${JSON.stringify(dir)}).exists()
    try:
        socket.create_connection(('1.1.1.1',443),timeout=1)
    except OSError:
        pass
    else:
        raise AssertionError('External network accessible')
    try:
        urllib.request.urlopen('http://127.0.0.1:8123/simple/idna/',timeout=1)
    except OSError:
        pass
    else:
        raise AssertionError('Install gateway exposed during execution')
    Path('result.txt').write_text('UV_TEST_PASSED\\n')
`,
    0,
    actor.id,
  );
  result = await sa.uv("run", ["python", "-m", "pytest", "-q"], 30, actor.id);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.match(result.stdout, /1 passed/);
  assert.equal(a.read("result.txt").content, "UV_TEST_PASSED\n");
  assert.equal(a.read("result.txt").updated_by, actor.id);
  a.write(
    "automatic.py",
    "import idna, sys\nassert sys.prefix == '/workspace/.venv'\nprint(idna.__version__)\n",
    0,
  );
  result = await sa.run("automatic.py");
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.match(result.stdout, /3.10/);
  // A second sync accepts the portable, canonical lock without changing it.
  const lock = a.read("uv.lock").content;
  result = await sa.uv("sync", [], 180, actor.id);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(a.read("uv.lock").content, lock);
  const tracked = execFileSync("git", ["-C", a.root, "ls-files"], {
    encoding: "utf8",
  });
  assert.ok(tracked.includes("pyproject.toml") && tracked.includes("uv.lock"));
  assert.ok(!tracked.includes(".venv") && !tracked.includes(".pytest_cache"));
  assert.ok(!a.directories().some((d) => d.path.includes(".venv")));
  assert.ok(!a.list().some((f) => f.path.includes("site-packages")));
  await assert.rejects(() => sb.uv("sync"), /disabled by the operator/);
  result = await sb.uv("venv");
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  result = await sb.uv("run", [
    "python",
    "-c",
    "import importlib.util; assert importlib.util.find_spec('idna') is None; print('isolated')",
  ]);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.match(result.stdout, /isolated/);
  result = await sa.uv("run", ["python", "-c", "while True: pass"], 1);
  assert.equal(result.status, "timed_out");
  assert.equal(a.locked, false);
  assert.equal(readdirSync(join(dir, "metadata", "uv-cache")).length, 2);
  projects.close();
  projects = new Projects(join(dir, "metadata"));
  assert.equal(projects.get(pa.id).workspace.environment().use_uv, true);
  result = await projects.get(pa.id).sandbox.run("automatic.py");
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  console.log(
    "uv integration passed: real PyPI install, offline pytest, per-project environments and caches, lockfile portability, Git exclusions, persistence, attribution, timeout and host/network isolation.",
  );
} finally {
  projects.close();
  rmSync(dir, { recursive: true, force: true });
}
