import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Workspace } from "../src/workspace.js";
import { PythonSandbox } from "../src/sandbox.js";
const s = new Store(),
  w = new Workspace(s),
  runner = new PythonSandbox(w);
let n = 0;
async function run(code, timeout = 10) {
  const path = `check${++n}.py`;
  w.write(path, code, 0);
  return runner.run(path, [], timeout);
}
try {
  assert.equal(
    (await runner.status()).ready,
    true,
    "Start Docker and pull python:3.12-slim",
  );
  w.mkdir("assets/empty");
  w.write("src/data.txt", "nested", 0);
  let r = await run(
    'from pathlib import Path\nassert Path("assets/empty").is_dir()\nassert Path("src/data.txt").read_text() == "nested"\nprint("sandbox works")\n',
  );
  assert.equal(r.exit_code, 0);
  assert.match(r.stdout, /sandbox works/);
  r = await run('import sys\nprint("failure", file=sys.stderr)\nsys.exit(7)');
  assert.equal(r.exit_code, 7);
  assert.equal(r.status, "failed");
  assert.match(r.stderr, /failure/);
  r = await run(`import os, socket, pathlib
assert os.getuid() == 65534
assert 'TOOLKIT_TOKEN' not in os.environ
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path('/Users').exists()
try:
 pathlib.Path('/workspace/escape.txt').write_text('no')
 raise AssertionError('workspace writable')
except OSError: pass
try:
 socket.create_connection(('1.1.1.1',443),timeout=1)
 raise AssertionError('network accessible')
except OSError: pass
pathlib.Path('/tmp/scratch.txt').write_text('temporary')
print('isolation verified')`);
  assert.equal(r.status, "succeeded", r.stderr);
  assert.match(r.stdout, /isolation verified/);
  r = await run(
    "from pathlib import Path\nassert not Path('/tmp/scratch.txt').exists()\nprint('fresh container')",
  );
  assert.equal(r.status, "succeeded");
  r = await run("while True: pass", 1);
  assert.equal(r.status, "timed_out");
  w.write("cancel.py", "import time\ntime.sleep(30)", 0);
  const controller = new AbortController();
  const pending = runner.run("cancel.py", [], 20, null, controller.signal);
  setTimeout(() => controller.abort(), 1200);
  r = await pending;
  assert.equal(r.status, "cancelled");
  r = await run('print("x" * 100000)');
  assert.equal(r.output_truncated, true);
  assert.ok(r.stdout.length <= 32000);
  assert.equal(w.runs().length, 7);
  console.log(
    "Sandbox tests passed: Python success/failure, host and network isolation, read-only files, fresh environments, timeout, cancellation, output cap.",
  );
} finally {
  s.db.close();
}
