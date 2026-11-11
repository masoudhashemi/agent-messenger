import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Workspace } from "../src/workspace.js";
import { Harness } from "../src/harness.js";
import { publishFileChanges } from "../src/file-changes.js";
import { renderMessage, renderDiffPreview, preview } from "../public/format.js";

test("harness posts immutable edit refs only to working self and active task chat", async () => {
  const store = new Store(),
    workspace = new Workspace(store);
  const a = store.createAgent("Builder", "Build"),
    b = store.createAgent("Reviewer", "Review"),
    c = store.createAgent("Other", "Other");
  const task = store.createChat("Task", "group", [a.id, b.id]);
  const unrelated = store.createChat("Unrelated", "direct", [a.id, c.id]);
  const harness = new Harness(
    store,
    () => {},
    async () =>
      JSON.stringify({
        working_note: { name: "Implementation", body: "Private plan" },
        actions: [
          {
            type: "write_file",
            path: "main.py",
            content: "print(1)\n",
            expected_revision: 0,
          },
          {
            type: "edit_file",
            path: "main.py",
            find: "1",
            replace: "2",
            expected_revision: 1,
          },
          {
            type: "edit_file",
            path: "main.py",
            find: "missing",
            replace: "3",
            expected_revision: 2,
          },
          { type: "finish" },
        ],
      }),
    { workspace, sandbox: {} },
  );
  harness.retrieval.focus(a.id, task.id);
  harness.start([a.id], "Build", 1);
  while (harness.run.status === "running")
    await new Promise((r) => setTimeout(r, 5));
  const notices = store.snapshot().chats.find((c) => c.id === task.id).messages;
  assert.equal(notices.length, 2);
  assert.deepEqual(
    notices.map((m) => JSON.parse(m.body.slice(12)).revision),
    [1, 2],
  );
  assert.ok(
    notices.every(
      (m) => m.sender_id === a.id && !m.body.includes("Private plan"),
    ),
  );
  assert.equal(
    store.snapshot().chats.find((c) => c.id === unrelated.id).messages.length,
    0,
  );
  assert.equal(
    store
      .snapshot(a.id)
      .chats.filter((c) => c.kind === "self")
      .flatMap((c) => c.messages)
      .filter((m) => m.body.startsWith("File change\n")).length,
    2,
  );
  assert.equal(workspace.read("main.py", 1).content, "print(1)\n");
  store.db.close();
});

test("execution changes produce one notice per text revision; no-op saves are silent", () => {
  const s = new Store(),
    w = new Workspace(s),
    a = s.createAgent("A", "Build");
  const chat = s.createChat("Notes", "self", [a.id]);
  const saved = w.write("main.py", "print(1)\n", 0, a.id);
  publishFileChanges(
    s,
    w,
    a.id,
    chat.id,
    chat.id,
    "write_file",
    saved,
    new Map([["main.py", 1]]),
  );
  assert.equal(
    s.snapshot().chats.find((c) => c.id === chat.id).messages.length,
    0,
  );
  const result = {
    status: "failed",
    error: "Process failed after writing files",
    changes: [
      {
        changes: [
          { path: "main.py", revision: 1 },
          { path: "image.png", artifact: true },
          { path: "main.py", revision: 1 },
        ],
      },
    ],
  };
  publishFileChanges(s, w, a.id, chat.id, chat.id, "uv_run", result, new Map());
  assert.equal(
    s.snapshot().chats.find((c) => c.id === chat.id).messages.length,
    1,
  );
  s.db.close();
});

test("chat diffs escape source and paths, show context and limit large patches", () => {
  const body =
    "File change\n" + JSON.stringify({ path: "<img>.py", revision: 2 });
  assert.match(preview(body), /v2/);
  assert.match(renderMessage(body), /&lt;img&gt;.py/);
  const html = renderDiffPreview("same\nold\n", "same\n<script>\n");
  assert.match(html, /diff-line removed/);
  assert.match(html, /diff-line added/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes("<script>"));
  const large = renderDiffPreview("", "x\n".repeat(200));
  assert.equal((large.match(/diff-line added/g) || []).length, 80);
  assert.match(large, /Preview limited/);
  assert.match(renderDiffPreview("a", "a\n"), /no trailing newline/);
});

test("execution deletion and creation diffs retain exact Git revisions in direct chats", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-chat-diff-"));
  const s = new Store();
  try {
    const w = new Workspace(s, {
      root: join(dir, "source"),
      gitDir: join(dir, "history.git"),
    });
    const a = s.createAgent("Builder", "Build"),
      b = s.createAgent("Reviewer", "Review");
    const self = s.createChat("Work", "self", [a.id]),
      direct = s.createChat("Task", "direct", [a.id, b.id]);
    w.write("old.py", "old line\n", 0, a.id);
    rmSync(join(w.root, "old.py"));
    writeFileSync(join(w.root, "new.py"), "new line\n");
    w.sync(a.id, "python", "execution-1");
    const result = {
      changes: w.history().filter((e) => e.execution_id === "execution-1"),
    };
    publishFileChanges(
      s,
      w,
      a.id,
      self.id,
      direct.id,
      "run_python",
      result,
      new Map([["old.py", 1]]),
    );
    const refs = s
      .snapshot(b.id)
      .chats.find((c) => c.id === direct.id)
      .messages.map((m) => JSON.parse(m.body.slice(12)));
    assert.equal(refs.length, 2);
    assert.equal(refs.find((r) => r.path === "old.py").kind, "deleted");
    assert.equal(w.read("old.py", 2).content, "");
    assert.match(
      renderDiffPreview(
        w.read("old.py", 1).content,
        w.read("old.py", 2).content,
      ),
      /diff-line removed/,
    );
    w.write("new.py", "later\n", 1, a.id);
    assert.equal(
      w.read("new.py", refs.find((r) => r.path === "new.py").revision).content,
      "new line\n",
    );
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
