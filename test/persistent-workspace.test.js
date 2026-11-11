import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { Workspace } from "../src/workspace.js";
import { Projects } from "../src/projects.js";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "relay-disk-"));
  const s = new Store(join(dir, "state.sqlite"));
  const options = {
    root: join(dir, "source"),
    gitDir: join(dir, "history.git"),
  };
  return {
    dir,
    s,
    options,
    cleanup() {
      s.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("persistent workspace writes real files and Git records authors and exact historical source", () => {
  const f = fixture();
  try {
    const w = new Workspace(f.s, f.options),
      a = f.s.createAgent("Builder", "Build");
    w.mkdir("src/empty", a.id);
    w.write("src/main.py", "print(1)\n", 0, a.id);
    w.write("src/main.py", "print(2)\n", 1, a.id);
    assert.equal(
      readFileSync(join(w.root, "src/main.py"), "utf8"),
      "print(2)\n",
    );
    assert.ok(existsSync(join(w.root, "src/empty")));
    assert.equal(w.read("src/main.py", 1).content, "print(1)\n");
    assert.equal(
      execFileSync("git", ["-C", w.root, "log", "-1", "--format=%an"], {
        encoding: "utf8",
      }).trim(),
      "Builder",
    );
    const commit = w.read("src/main.py").git_commit;
    assert.match(commit, /^[a-f0-9]{40}$/);
    f.s.run(
      "UPDATE file_versions SET content='corrupted cache' WHERE path=? AND revision=1",
      "src/main.py",
    );
    assert.equal(w.read("src/main.py", 1).content, "print(1)\n");
    const reopened = new Workspace(f.s, f.options);
    assert.equal(reopened.read("src/main.py").revision, 2);
  } finally {
    f.cleanup();
  }
});

test("external edits, deletion and recreation are detected without overwriting revision history", () => {
  const f = fixture();
  try {
    const w = new Workspace(f.s, f.options);
    w.write("a.py", "one\n", 0);
    writeFileSync(join(w.root, "a.py"), "two\n");
    assert.equal(w.read("a.py").revision, 2);
    assert.equal(w.history()[0].source, "external");
    assert.throws(() => w.write("a.py", "lost update", 1), /changed/);
    rmSync(join(w.root, "a.py"));
    assert.equal(w.list().length, 0);
    assert.equal(w.versions("a.py")[0].kind, "deleted");
    assert.equal(w.read("a.py", 3).content, "");
    w.write("a.py", "three\n", 0);
    assert.equal(w.read("a.py").revision, 4);
    assert.equal(w.read("a.py", 1).content, "one\n");
    w.locked = true;
    assert.throws(() => w.mkdir("blocked"), /busy/);
    assert.throws(() => w.write("a.py", "no", 4), /busy/);
    w.locked = false;
  } finally {
    f.cleanup();
  }
});

test("migration replays existing versions into Git and preserves original authors", () => {
  const f = fixture();
  try {
    const original = new Workspace(f.s),
      a = f.s.createAgent("Original author", "Build");
    original.write("main.py", "before\n", 0, a.id);
    original.write("main.py", "after\n", 1, a.id);
    original.mkdir("empty");
    const w = new Workspace(f.s, f.options);
    assert.equal(w.read("main.py", 1).content, "before\n");
    assert.equal(w.read("main.py", 2).content, "after\n");
    assert.ok(existsSync(join(w.root, "empty")));
    assert.equal(
      execFileSync("git", ["-C", w.root, "rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      "2",
    );
    assert.equal(w.versions("main.py")[0].updated_by, a.id);
  } finally {
    f.cleanup();
  }
});

test("symlinks cannot expose host content or redirect writes; Git metadata is reserved", () => {
  const f = fixture();
  try {
    const w = new Workspace(f.s, f.options);
    const outside = join(f.dir, "private.txt");
    writeFileSync(outside, "HOST_SECRET");
    symlinkSync(outside, join(w.root, "link.txt"));
    w.sync();
    assert.equal(w.list().length, 0);
    assert.ok(w.warnings.some((x) => x.includes("link.txt")));
    assert.throws(() => w.write("link.txt", "overwrite", 0), /links/);
    assert.equal(readFileSync(outside, "utf8"), "HOST_SECRET");
    assert.throws(() => w.write(".git/config", "x", 0), /traversal/);
  } finally {
    f.cleanup();
  }
});

test("new projects accept empty custom folders and reject nonempty or overlapping workspaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-custom-"));
  const projects = new Projects(join(dir, "metadata"));
  try {
    const root = join(dir, "visible-project");
    const p = projects.create("Visible", "", null, root);
    assert.ok(p.workspace_path.endsWith("/visible-project"));
    const w = projects.get(p.id).workspace;
    w.write("hello.txt", "hello", 0);
    assert.equal(readFileSync(join(root, "hello.txt"), "utf8"), "hello");
    assert.throws(
      () => projects.create("Nested", "", null, join(root, "child")),
      /overlap/,
    );
    const occupied = join(dir, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep.txt"), "keep");
    assert.throws(() => projects.create("No", "", null, occupied), /empty/);
    assert.equal(readFileSync(join(occupied, "keep.txt"), "utf8"), "keep");
  } finally {
    projects.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binary artifacts live on disk and are versioned in Git without entering text search", () => {
  const f = fixture();
  try {
    const w = new Workspace(f.s, f.options);
    const path = join(w.root, "image.bin");
    writeFileSync(path, Buffer.from([0, 1, 2, 255]));
    w.sync();
    assert.equal(w.list().length, 0);
    assert.equal(w.unsupported[0].path, "image.bin");
    assert.equal(w.history()[0].changes[0].artifact, true);
    const commit = w.history()[0].git_commit;
    assert.deepEqual(
      execFileSync("git", [
        "--git-dir=" + w.folder.gitDir,
        "show",
        commit + ":image.bin",
      ]),
      Buffer.from([0, 1, 2, 255]),
    );
    assert.equal(w.folder.artifactCache.has("image.bin"), true);
    assert.equal(w.sync(), false);
    rmSync(path);
    w.sync();
    assert.equal(w.folder.artifactCache.has("image.bin"), false);
    assert.equal(w.history()[0].changes[0].kind, "deleted");
  } finally {
    f.cleanup();
  }
});
