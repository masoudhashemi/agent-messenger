import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Workspace } from "../src/workspace.js";
import { Retrieval } from "../src/retrieval.js";
import { buildContext } from "../src/context.js";
import { Harness } from "../src/harness.js";
function fixture() {
  const s = new Store(),
    w = new Workspace(s);
  const a = s.createAgent("Atlas", "Coordinate"),
    b = s.createAgent("Nova", "Build"),
    c = s.createAgent("Sage", "Review");
  return { s, w, a, b, c, r: new Retrieval(s, w) };
}
test("message search scopes titles, snippets and pagination to membership before returning results", () => {
  const { s, r, a, b, c } = fixture();
  const dm = s.createChat("Private title", "direct", [a.id, b.id]);
  const group = s.createChat("Shared", "group", [a.id, c.id]);
  const notes = s.createChat("Only Nova", "self", [b.id]);
  s.send(dm.id, a.id, "needle private sentinel");
  s.send(notes.id, b.id, "needle private notebook");
  const visible = s.send(group.id, a.id, "needle visible");
  const result = r.execute(c.id, {
    type: "search_messages",
    query: "needle",
    limit: 1,
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].id, visible.id);
  assert.equal(result.next_offset, null);
  assert.ok(!JSON.stringify(result).includes("Private"));
  assert.ok(!JSON.stringify(r.overview(c.id)).includes("Only Nova"));
  assert.throws(
    () =>
      r.execute(c.id, {
        type: "search_messages",
        query: "needle",
        chat_ids: [dm.id],
      }),
    /unavailable/,
  );
  assert.throws(
    () => r.execute(c.id, { type: "read_message", message_id: 1 }),
    /unavailable/,
  );
  assert.throws(
    () => r.execute(c.id, { type: "read_chat", chat_id: dm.id }),
    /unavailable/,
  );
  s.run("DELETE FROM members WHERE chat_id=? AND agent_id=?", group.id, c.id);
  assert.deepEqual(
    r.execute(c.id, { type: "search_messages", query: "needle" }).results,
    [],
  );
  s.db.close();
});
test("FTS indexes existing data and follows new messages, file revisions and execution updates", () => {
  const { s, w, r, a } = fixture();
  const chat = s.createChat("Notes", "self", [a.id]);
  const m = s.send(chat.id, a.id, "quasar evidence");
  s.run("DELETE FROM messages WHERE id=?", m.id);
  assert.equal(
    r.execute(a.id, { type: "search_messages", query: "quasar" }).results
      .length,
    0,
  );
  w.write("calc.py", "def original(): return 1\n", 0, a.id);
  assert.equal(
    r.execute(a.id, { type: "search_files", query: "original" }).results.length,
    1,
  );
  w.edit("calc.py", "original", "replacement", 1, a.id);
  assert.equal(
    r.execute(a.id, { type: "search_files", query: "original" }).results.length,
    0,
  );
  assert.equal(
    r.execute(a.id, { type: "search_file_history", query: "original" })
      .results[0].revision,
    1,
  );
  w.record({
    id: "run1",
    path: "calc.py",
    status: "failed",
    stdout: "",
    stderr: "unique failure",
  });
  assert.equal(
    r.execute(a.id, { type: "search_executions", query: "unique" }).results
      .length,
    1,
  );
  w.record({
    id: "run1",
    path: "calc.py",
    status: "succeeded",
    stdout: "passed",
    stderr: "",
  });
  assert.equal(
    r.execute(a.id, { type: "search_executions", query: "unique" }).results
      .length,
    0,
  );
  assert.equal(
    r.execute(a.id, { type: "read_execution", execution_id: "run1" }).output,
    "passed",
  );
  const old = new Store();
  const agent = old.createAgent("Old", "Old");
  const c = old.createChat("Archive", "self", [agent.id]);
  old.send(c.id, agent.id, "historical evidence");
  assert.equal(
    new Retrieval(old).execute(agent.id, {
      type: "search_messages",
      query: "historical",
    }).results.length,
    1,
  );
  old.db.close();
  s.db.close();
});
test("paginated chat reads reach messages older than the old 200-message window", () => {
  const { s, r, a } = fixture(),
    chat = s.createChat("Archive", "self", [a.id]);
  for (let i = 0; i < 225; i++) s.send(chat.id, null, "archive item " + i);
  let after = 0,
    ids = [];
  do {
    const result = r.execute(a.id, {
      type: "read_chat",
      chat_id: chat.id,
      after_message_id: after,
      limit: 30,
    });
    ids.push(...result.messages.map((m) => m.id));
    after = result.next_after_message_id;
  } while (after !== null);
  assert.equal(new Set(ids).size, 225);
  assert.equal(ids[0], 1);
  assert.equal(s.readState(chat.id, a.id).unread_count, 225);
  s.db.close();
});
test("read receipts do not mark skipped messages or search snippets read", () => {
  const { s, r, a } = fixture(),
    chat = s.createChat("Inbox", "self", [a.id]);
  const msgs = Array.from({ length: 10 }, (_, i) =>
    s.send(chat.id, null, "message " + i),
  );
  r.execute(a.id, { type: "list_chats" });
  r.execute(a.id, { type: "search_messages", query: "message" });
  assert.equal(s.readState(chat.id, a.id).unread_count, 10);
  s.markSeen(
    a.id,
    msgs.slice(4).map((m) => ({ chat_id: chat.id, message_id: m.id })),
  );
  assert.equal(s.readState(chat.id, a.id).unread_count, 4);
  assert.equal(s.readState(chat.id, a.id).last_read_id, 0);
  s.markSeen(
    a.id,
    msgs.slice(0, 4).map((m) => ({ chat_id: chat.id, message_id: m.id })),
  );
  assert.equal(s.readState(chat.id, a.id).unread_count, 0);
  assert.equal(s.readState(chat.id, a.id).last_read_id, 10);
  s.db.close();
});
test("file ranges, revisions and long-line continuations preserve exact content", () => {
  const { s, w, r, a } = fixture();
  const content = "x".repeat(15000) + "\nlast\n";
  w.write("long.py", content, 0);
  let next = { start_line: 1 },
    output = "";
  while (next) {
    const result = r.execute(a.id, {
      type: "read_file",
      path: "long.py",
      ...next,
    });
    output += result.content;
    next = result.next;
  }
  assert.equal(output, content);
  w.edit("long.py", "last", "changed", 1);
  assert.equal(
    r.execute(a.id, {
      type: "read_file",
      path: "long.py",
      revision: 1,
      start_line: 2,
      end_line: 2,
    }).content,
    "last\n",
  );
  let diffAction = { type: "read_file_diff", path: "long.py", revision: 2 };
  const diffRows = [];
  do {
    const part = r.execute(a.id, diffAction);
    diffRows.push(...part.results);
    diffAction = part.next;
  } while (diffAction);
  assert.ok(diffRows.some((row) => row.type === "added"));
  assert.throws(() =>
    r.execute(a.id, { type: "read_file", path: "../secret" }),
  );
  assert.throws(() =>
    r.execute(a.id, { type: "read_file", path: "long.py", start_line: 0 }),
  );
  s.db.close();
});
test("context contains a focused window and notebook, not every accessible transcript", () => {
  const { s, r, a, b } = fixture();
  const old = s.createChat("Old decision", "direct", [a.id, b.id]);
  s.send(old.id, b.id, "ACCESSIBLE_OLD_SENTINEL");
  const notebook = s.createChat("Current notebook", "self", [a.id]);
  s.send(notebook.id, a.id, "Turn 1 · Working note\nCurrent next step");
  r.focus(a.id, notebook.id, true);
  const active = s.createChat("Active", "group", [a.id, b.id]);
  for (let i = 0; i < 10; i++) s.send(active.id, b.id, "active item " + i);
  const req = s.send(active.id, null, "New task");
  const frame = buildContext(r, {
    agent: a,
    system: "system",
    task: "task",
    incoming: [req],
    turn: 1,
    turnLimit: 5,
  });
  const raw = JSON.stringify(frame.payload);
  assert.ok(!raw.includes("ACCESSIBLE_OLD_SENTINEL"));
  assert.ok(raw.includes("Old decision"));
  assert.ok(raw.includes("Current next step"));
  assert.ok(!raw.includes("active item 0"));
  assert.ok(frame.payload.context.chats.every((c) => !c.messages));
  s.markSeen(a.id, frame.receipts);
  assert.equal(s.readState(old.id, a.id).unread_count, 1);
  assert.ok(s.readState(active.id, a.id).unread_count > 0);
  s.db.close();
});
test("context stays within its byte budget and references omitted tool results", () => {
  const { s, r, a, b, w } = fixture();
  for (let i = 0; i < 35; i++) {
    const c = s.createChat(
      "Group " + i,
      "group",
      [a.id, b.id],
      null,
      "description ".repeat(80),
    );
    s.send(c.id, b.id, "漢".repeat(4000));
  }
  w.write("large.txt", "x".repeat(50000), 0);
  const feedback = {
    results: [{ path: "large.txt", content: "x".repeat(50000) }],
    source: { chat_id: "audit", message_ids: [7] },
  };
  const frame = buildContext(r, {
    agent: a,
    system: "system",
    task: "task",
    feedback,
    turn: 1,
    turnLimit: 5,
    budget: 16000,
  });
  assert.ok(frame.usage.bytes <= 16000);
  assert.equal(frame.payload.previous_action_results[0].content_loaded, false);
  assert.deepEqual(
    frame.payload.previous_action_results[0].source.message_ids,
    [7],
  );
  assert.ok(frame.payload.context.chats.length <= 25);
  assert.throws(
    () =>
      buildContext(r, {
        agent: a,
        system: "x".repeat(16000),
        task: "task",
        budget: 16000,
      }),
    /exceed/,
  );
  s.db.close();
});
test("search is literal, paginated, bounded and never expands FTS query syntax", () => {
  const { s, r, a } = fixture(),
    chat = s.createChat("Notes", "self", [a.id]);
  for (let i = 0; i < 25; i++) s.send(chat.id, a.id, "needle " + i);
  const first = r.execute(a.id, {
      type: "search_messages",
      query: "needle",
      limit: 10,
    }),
    second = r.execute(a.id, {
      type: "search_messages",
      query: "needle",
      limit: 10,
      offset: first.next_offset,
    });
  assert.equal(first.results.length, 10);
  assert.ok(
    second.results.every((m) => !first.results.some((n) => n.id === m.id)),
  );
  assert.ok(first.results.every((m) => m.snippet.length <= 300));
  assert.equal(
    r.execute(a.id, { type: "search_messages", query: "needle OR nonexistent" })
      .results.length,
    0,
  );
  assert.throws(
    () => r.execute(a.id, { type: "search_messages", query: '"*' }),
    /search words/,
  );
  assert.throws(() =>
    r.execute(a.id, { type: "read_chat", chat_id: chat.id, limit: 999 }),
  );
  s.db.close();
});
test("retrieval-only turns expose results on the next model call before finishing", async () => {
  const { s, w, a, b, r } = fixture(),
    chat = s.createChat("Archive", "direct", [a.id, b.id]);
  const original = s.send(chat.id, b.id, "findable decision");
  for (let i = 0; i < 8; i++) s.send(chat.id, b.id, "newer message " + i);
  let calls = 0;
  const h = new Harness(
    s,
    () => {},
    async (messages) => {
      const ctx = JSON.parse(messages[1].content);
      calls++;
      if (calls === 1)
        return JSON.stringify({
          working_note: { name: "Research", body: "Search older decisions." },
          actions: [
            { type: "search_messages", query: "findable" },
            { type: "finish" },
          ],
        });
      assert.ok(
        JSON.stringify(ctx.previous_action_results).includes(
          "findable decision",
        ),
      );
      assert.equal(s.readState(chat.id, a.id).unread_count, 3);
      return JSON.stringify({
        working_note: { name: "Research", body: "Read the located source." },
        actions: [{ type: "read_message", message_id: original.id }],
      });
    },
    { workspace: w, sandbox: {} },
  );
  h.start([a.id], "Look up the decision", 2);
  while (h.run.status === "running") await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2);
  assert.equal(s.readState(chat.id, a.id).unread_count, 3);
  s.db.close();
});
test("conversation search obeys permissions and current task focus survives old unread history", () => {
  const { s, r, a, b, c } = fixture();
  const archive = s.createChat(
    "Architecture archive",
    "direct",
    [a.id, b.id],
    null,
    "Lyra prior decisions",
  );
  s.send(archive.id, b.id, "Old unread archive");
  const current = s.createChat("Current work", "group", [a.id, c.id]);
  const req = s.send(current.id, null, "New current task");
  const frame = buildContext(r, {
    agent: a,
    system: "system",
    task: "Work",
    incoming: [req],
    turn: 1,
    turnLimit: 4,
  });
  s.markSeen(a.id, frame.receipts);
  const next = buildContext(r, {
    agent: a,
    system: "system",
    task: "Work",
    turn: 2,
    turnLimit: 4,
  });
  assert.equal(next.payload.context.active_chat.id, current.id);
  assert.equal(
    next.payload.context.active_chat.messages[0].body,
    "New current task",
  );
  assert.equal(
    r.execute(c.id, { type: "search_chats", query: "Lyra" }).results.length,
    0,
  );
  assert.equal(
    r.execute(a.id, { type: "search_chats", query: "Lyra" }).results[0].chat_id,
    archive.id,
  );
  s.db.close();
});
test("context orders static fields first and exposes retrieval pointers for unread gaps and past tool audits", () => {
  const { s, r, a, b } = fixture();
  const group = s.createChat("Design", "group", [a.id, b.id]);
  const firstUnread = s.send(group.id, b.id, "early unread decision");
  for (let i = 0; i < 7; i++) s.send(group.id, b.id, "recent message " + i);
  const self = s.createChat("Notebook", "self", [a.id]);
  s.send(self.id, a.id, "Turn 1 · Working note\nChecked initial files.");
  const audit = s.send(
    self.id,
    a.id,
    'Turn 1 · Action results\n[{"action":"list_files","result":{"files":[]}}]',
  );
  r.focus(a.id, group.id);
  r.focus(a.id, self.id, true);
  const frame = buildContext(r, {
    agent: a,
    system: "system",
    task: "Coordinate",
    turn: 2,
    turnLimit: 6,
  });
  assert.deepEqual(Object.keys(frame.payload).slice(0, 5), [
    "you",
    "task",
    "turn_limit",
    "context_policy",
    "coding",
  ]);
  const dirEntry = frame.payload.context.chats.find((c) => c.id === group.id);
  assert.deepEqual(dirEntry.members, [a.id, b.id]);
  assert.equal(dirEntry.first_unread_id, firstUnread.id);
  assert.equal(
    frame.payload.context.active_chat.older_messages_available,
    true,
  );
  assert.equal(
    frame.payload.context.active_chat.first_unread_id,
    firstUnread.id,
  );
  assert.deepEqual(
    frame.payload.context.working_thread.messages[0].result_message_ids,
    [audit.id],
  );
  const longBody = "row | value\n".repeat(300) + "FINAL_TABLE_ROW";
  s.send(group.id, b.id, longBody);
  const withLong = buildContext(r, {
    agent: a,
    system: "system",
    task: "Coordinate",
    turn: 3,
    turnLimit: 6,
  });
  const latestInContext = withLong.payload.context.active_chat.messages.at(-1);
  assert.equal(latestInContext.body_truncated, false);
  assert.ok(latestInContext.body.endsWith("FINAL_TABLE_ROW"));
  const readPage = r.execute(a.id, {
    type: "read_chat",
    chat_id: group.id,
    after_message_id: latestInContext.id - 1,
    limit: 5,
  });
  assert.equal(readPage.messages[0].body, longBody);
  assert.equal(readPage.messages[0].body_truncated, false);
  const dm = s.createChat("Atlas & Nova", "direct", [a.id, b.id]);
  s.send(dm.id, b.id, "Direct question from Nova");
  const dmFocused = buildContext(r, {
    agent: a,
    system: "system",
    task: "Coordinate",
    turn: 4,
    turnLimit: 6,
  });
  assert.equal(dmFocused.payload.context.active_chat.id, dm.id);
  assert.equal(
    dmFocused.payload.context.active_chat.messages[0].body,
    "Direct question from Nova",
  );
  s.db.close();
});
