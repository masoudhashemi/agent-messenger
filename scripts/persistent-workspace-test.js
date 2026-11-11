import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects } from "../src/projects.js";
const dir = mkdtempSync(join(tmpdir(), "relay-volume-test-"));
let projects = new Projects(join(dir, "metadata"));
try {
  const project = projects.create(
    "Persistent sandbox",
    "",
    null,
    join(dir, "visible-source"),
  );
  let { workspace: w, sandbox, store } = projects.get(project.id);
  const a = store.createAgent("Artifact builder", "Build files");
  w.write("old.txt", "remove me\n", 0, a.id);
  w.write(
    "generate.py",
    `from pathlib import Path
import os
assert 'TOOLKIT_TOKEN' not in os.environ
assert not Path('/var/run/docker.sock').exists()
assert not Path(${JSON.stringify(dir + "/metadata")}).exists()
Path('outputs/nested').mkdir(parents=True, exist_ok=True)
Path('outputs/nested/result.txt').write_text('persistent result\\n')
Path('old.txt').unlink()
print('generated persistent files')
`,
    0,
    a.id,
  );
  const pending = sandbox.run("generate.py", [], 20, a.id);
  assert.throws(() => w.write("concurrent.txt", "blocked", 0), /busy/);
  const result = await pending;
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(
    readFileSync(join(w.root, "outputs/nested/result.txt"), "utf8"),
    "persistent result\n",
  );
  assert.equal(existsSync(join(w.root, "old.txt")), false);
  assert.equal(w.read("outputs/nested/result.txt").updated_by, a.id);
  assert.equal(w.read("old.txt", 1).content, "remove me\n");
  assert.ok(
    result.changes.some(
      (e) => e.actor === a.id && e.execution_id === result.id,
    ),
  );
  w.write(
    "check.py",
    `from pathlib import Path
assert Path('outputs/nested/result.txt').read_text() == 'persistent result\\n'
Path('outputs/nested/result.txt').write_text('changed before failure\\n')
raise RuntimeError('expected failure')
`,
    0,
    a.id,
  );
  const failure = await sandbox.run("check.py", [], 20, a.id);
  assert.equal(failure.status, "failed");
  assert.equal(w.read("outputs/nested/result.txt").revision, 2);
  assert.equal(
    w.read("outputs/nested/result.txt", 1).content,
    "persistent result\n",
  );
  projects.close();
  projects = new Projects(join(dir, "metadata"));
  w = projects.get(project.id).workspace;
  assert.equal(
    w.read("outputs/nested/result.txt").content,
    "changed before failure\n",
  );
  assert.equal(w.versions("outputs/nested/result.txt").length, 2);
  console.log(
    "Persistent Docker tests passed: generated files, directories, deletion history, agent attribution, edit locking, cross-container persistence, failed-run changes, restart recovery, isolated metadata.",
  );
} finally {
  projects.close();
  rmSync(dir, { recursive: true, force: true });
}
