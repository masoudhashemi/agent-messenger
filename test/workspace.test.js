import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Workspace } from "../src/workspace.js";
import { Harness } from "../src/harness.js";
test("shared file editing checks revisions, preserves versions and rejects traversal", () => {
  const s = new Store(),
    w = new Workspace(s);
  const a = s.createAgent("Builder", "Build"),
    b = s.createAgent("Reviewer", "Review");
  w.write("src/main.py", 'print("hello")\n', 0, a.id);
  assert.equal(w.read("src/main.py").revision, 1);
  w.edit("src/main.py", "hello", "world", 1, b.id);
  assert.equal(w.read("src/main.py").content, 'print("world")\n');
  assert.equal(w.read("src/main.py").updated_by, b.id);
  assert.throws(
    () => w.write("src/main.py", "lost update", 1, a.id),
    /changed/,
  );
  assert.equal(w.versions("src/main.py").length, 2);
  for (const path of [
    "../secret",
    "/etc/passwd",
    "a/../../b",
    "a\\b",
    "a//b",
    "a/./b",
  ])
    assert.throws(() => w.write(path, "x", 0));
  assert.throws(() => w.write("src", "x", 0), /conflicts/);
  assert.throws(() => w.edit("src/main.py", "missing", "x", 2), /exactly once/);
  s.db.close();
});
test("coding tools require a working note and expose shared files to a collaborator", async () => {
  const s = new Store(),
    workspace = new Workspace(s),
    a = s.createAgent("Builder", "Build"),
    b = s.createAgent("Reviewer", "Review");
  let seen;
  const h = new Harness(
    s,
    () => {},
    async (messages) => {
      const ctx = JSON.parse(messages[1].content);
      if (ctx.you.id === a.id)
        return JSON.stringify({
          working_note: {
            name: "Implementation",
            body: "Create a small function for review.",
          },
          actions: [
            {
              type: "write_file",
              path: "maths.py",
              content: "def add(a,b): return a+b\n",
              expected_revision: 0,
            },
            { type: "direct", agent_id: b.id, body: "Review maths.py" },
            { type: "finish" },
          ],
        });
      seen = ctx;
      return JSON.stringify({
        working_note: {
          name: "Review",
          body: "Read and inspect the shared implementation.",
        },
        actions: [{ type: "read_file", path: "maths.py" }, { type: "finish" }],
      });
    },
    { workspace, sandbox: {} },
  );
  h.start([a.id, b.id], "Collaborate", 2);
  while (h.run.status === "running") await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen.coding.files[0].path, "maths.py");
  assert.equal(workspace.read("maths.py").updated_by, a.id);
  assert.ok(
    s
      .snapshot(b.id)
      .chats.filter((c) => c.kind === "self")
      .some((c) => c.messages.some((m) => m.body.includes("def add"))),
  );
  s.db.close();
});
test("historical source retains each agent attribution without changing current content", () => {
  const s = new Store(),
    w = new Workspace(s);
  const a = s.createAgent("Builder", "Build"),
    b = s.createAgent("Reviewer", "Review");
  w.write("main.py", "print(1)\n", 0, a.id);
  w.edit("main.py", "1", "2", 1, b.id);
  const original = w.read("main.py", 1),
    latest = w.read("main.py", 2);
  assert.equal(original.content, "print(1)\n");
  assert.equal(original.updated_by, a.id);
  assert.equal(latest.updated_by, b.id);
  assert.ok(original.updated_at);
  assert.equal(w.read("main.py").revision, 2);
  assert.throws(() => w.read("main.py", 0), /positive/);
  assert.throws(() => w.read("main.py", 1.5), /positive/);
  assert.throws(() => w.read("main.py", 3), /not found/);
  assert.throws(() => w.read("../main.py", 1), /relative/);
  s.db.close();
});

test("directories preserve empty folders, infer parents and reject file collisions", () => {
  const s = new Store(),
    w = new Workspace(s),
    a = s.createAgent("A", "Build");
  w.mkdir("src/empty", a.id);
  w.write("src/lib/tool.py", "x = 1\n", 0, a.id);
  assert.deepEqual(
    w.ls().entries.map((e) => e.path),
    ["src"],
  );
  assert.deepEqual(
    w.ls({ path: "src" }).entries.map((e) => e.path),
    ["src/empty", "src/lib"],
  );
  assert.deepEqual(w.ls({ path: "src/empty" }).entries, []);
  assert.equal(w.ls({ recursive: true, limit: 1 }).next_offset, 1);
  assert.throws(() => w.write("src/empty", "oops", 0), /directory/);
  assert.throws(() => w.mkdir("src/lib/tool.py/child"), /conflicts/);
  assert.throws(() => w.mkdir("../escape"), /traversal/);
  assert.equal(
    new Workspace(s).directories().find((d) => d.path === "src/empty")
      .created_by,
    a.id,
  );
  s.db.close();
});

test("grep pages literal line matches and sed preserves revision attribution", () => {
  const s = new Store(),
    w = new Workspace(s),
    a = s.createAgent("A", "Build");
  w.write("src/a.py", "TODO [x]\nsecond TODO\nlast\n", 0);
  w.write("other.py", "TODO", 0);
  const page = w.grep({
    query: "todo",
    path: "src",
    case_sensitive: false,
    limit: 1,
  });
  assert.equal(page.results[0].line, 1);
  assert.equal(page.next_offset, 1);
  assert.equal(
    w.grep({ query: "TODO", path: "src", offset: 1 }).results[0].line,
    2,
  );
  assert.equal(w.grep({ query: "[x]" }).results.length, 1);
  w.sed(
    {
      path: "src/a.py",
      start_line: 2,
      end_line: 2,
      replacement: "replacement",
      expected_revision: 1,
    },
    a.id,
  );
  assert.equal(w.read("src/a.py").content, "TODO [x]\nreplacement\nlast\n");
  assert.equal(w.read("src/a.py").updated_by, a.id);
  assert.equal(w.read("src/a.py", 1).content, "TODO [x]\nsecond TODO\nlast\n");
  assert.throws(
    () =>
      w.sed({
        path: "src/a.py",
        start_line: 1,
        replacement: "",
        expected_revision: 1,
      }),
    /changed/,
  );
  assert.throws(
    () =>
      w.sed({
        path: "src/a.py",
        start_line: 99,
        replacement: "",
        expected_revision: 2,
      }),
    /range/,
  );
  s.db.close();
});

test("harness exposes folder exploration and records range edits in self chat", async () => {
  const s = new Store(),
    w = new Workspace(s),
    a = s.createAgent("Builder", "Build");
  let turn = 0;
  const batches = [
    [
      { type: "mkdir", path: "src/empty" },
      {
        type: "write_file",
        path: "src/main.py",
        content: "value = 1\n",
        expected_revision: 0,
      },
    ],
    [
      { type: "ls", path: "src" },
      { type: "grep", path: "src", query: "value" },
    ],
    [
      {
        type: "sed",
        path: "src/main.py",
        start_line: 1,
        replacement: "value = 2",
        expected_revision: 1,
      },
      { type: "finish" },
    ],
  ];
  const h = new Harness(
    s,
    () => {},
    async () =>
      JSON.stringify({
        working_note: {
          name: "Build",
          body: "Inspect and update project source.",
        },
        actions: batches[turn++],
      }),
    { workspace: w, sandbox: {} },
  );
  h.start([a.id], "Build nested source", 3);
  while (h.run.status === "running") await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.read("src/main.py").content, "value = 2\n");
  assert.equal(w.read("src/main.py").updated_by, a.id);
  assert.ok(!h.history.some((x) => x.status === "error"));
  assert.ok(
    s
      .snapshot(a.id)
      .chats.some((c) =>
        c.messages.some((m) => m.body.includes('"action": "grep"')),
      ),
  );
  s.db.close();
});
