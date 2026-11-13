import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { Workspace } from "../src/workspace.js";
const response = (actions) =>
  JSON.stringify({ working_note: { name: "Notes", body: "Fixture" }, actions });
const finish = { type: "finish", summary: "Fixture complete" };
async function settle(h) {
  for (let i = 0; i < 1000; i++) {
    if (h.run.status !== "running" && !h.scheduled) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw Error("Did not settle");
}

test("model failures and invalid JSON always produce private, durable error entries", async () => {
  for (const result of [new Error("Model HTTP 504"), "not valid JSON"]) {
    const s = new Store();
    try {
      const a = s.createAgent("A", "Work"),
        b = s.createAgent("B", "Work");
      const h = new Harness(
        s,
        () => {},
        async () => {
          if (result instanceof Error) throw result;
          return result;
        },
      );
      h.start([a.id], "Work", 1);
      await settle(h);
      assert.match(
        s
          .chats(a.id)
          .flatMap((c) => s.messages(c.id))
          .map((m) => m.body)
          .join("\n"),
        /Error/,
      );
      assert.equal(s.chats(b.id).length, 0);
      if (typeof result === "string")
        assert.equal(
          s.get(
            "SELECT COUNT(*) n FROM artifacts WHERE label='Unsuccessful model response'",
          ).n,
          1,
        );
    } finally {
      s.db.close();
    }
  }
});

test("resume preserves teammate deliverables and errors across a harness restart", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work"),
      b = s.createAgent("B", "Work"),
      w = new Workspace(s);
    let h = new Harness(
      s,
      () => {},
      async (m) =>
        response(
          JSON.parse(m[1].content).you.id === a.id
            ? [finish]
            : [
                { type: "set_deliverables", paths: ["report.md"] },
                { type: "write_file", path: "report.md", content: "x" },
              ],
        ),
      { workspace: w },
    );
    h.start([a.id, b.id], "Write report", 2);
    await settle(h);
    assert.ok(h.run.work[b.id].errors["invalid:write_file"]);
    h = new Harness(
      s,
      () => {},
      async () => response([finish]),
      { workspace: w },
    );
    h.start([a.id, b.id], "Write report", 4, [], { resume: true });
    await settle(h);
    assert.deepEqual(h.run.work[b.id].required_files, ["report.md"]);
    assert.equal(h.run.completion.status, "incomplete");
    assert.equal(w.list().length, 0);
    h.completion = async (m) =>
      response(
        JSON.parse(m[1].content).you.id === b.id
          ? [
              {
                type: "write_file",
                path: "report.md",
                content: "done",
                expected_revision: 0,
              },
              finish,
            ]
          : [finish],
      );
    h.start([a.id, b.id], "Write report", 4, [], { resume: true });
    await settle(h);
    assert.equal(h.run.completion.status, "checks_passed");
  } finally {
    s.db.close();
  }
});

test("private enrollment does not grant existing group history; explicit invite does", () => {
  const s = new Store();
  try {
    const ids = ["A", "B", "C", "D"].map((n) => s.createAgent(n, "Work").id);
    const h = new Harness(s),
      run = {
        ids: ids.slice(0, 3),
        initial_ids: ids.slice(0, 3),
        status: "running",
        work: {},
      };
    h.run = run;
    const g = h.ensureTeamGroup(run);
    s.send(g.id, ids[0], "PRIVATE_TEAM_HISTORY");
    const direct = s.createChat("Private handoff", "direct", [ids[0], ids[3]]);
    h.enroll(s.send(direct.id, ids[0], "Help privately"), run, false);
    h.ensureTeamGroup(run);
    assert.throws(() => s.messages(g.id, ids[3]), /unavailable/);
    assert.equal(run.work[ids[3]].shared_group_id, undefined);
    s.addMember(g.id, ids[3], ids[0]);
    h.ensureTeamGroup(run);
    assert.equal(s.messages(g.id, ids[3])[0].body, "PRIVATE_TEAM_HISTORY");
  } finally {
    s.db.close();
  }
});

test("progress cannot resolve requests; final answer resolves only specified IDs", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work"),
      b = s.createAgent("B", "Work"),
      chat = s.createChat("Direct", "direct", [a.id, b.id]);
    let h = new Harness(
      s,
      () => {},
      async () =>
        response([
          { type: "send", chat_id: chat.id, body: "I will look later" },
          finish,
        ]),
    );
    // Queue both without starting a live loop, then process them together.
    h.run = { status: "running", ids: [b.id] };
    const first = s.send(chat.id, a.id, "First question"),
      second = s.send(chat.id, a.id, "Second question");
    h.wake(first);
    h.wake(second);
    h.run.status = "completed";
    h.start([b.id], "Answer", 1);
    await settle(h);
    assert.deepEqual(
      h.requests.map((r) => r.pending_replies),
      [[b.id], [b.id]],
    );
    assert.equal(h.run.completion.status, "incomplete");
    h.completion = async () =>
      response([
        {
          type: "reply",
          chat_id: chat.id,
          body: "First answer",
          request_ids: [first.id],
        },
        finish,
      ]);
    h.start([b.id], "Answer", 1);
    await settle(h);
    assert.deepEqual(
      h.requests.map((r) => r.pending_replies),
      [[], [b.id]],
    );
    assert.equal(h.run.completion.status, "incomplete");
    assert.throws(
      () =>
        h.replyRequests(b.id, chat.id, { type: "reply", request_ids: [999] }, [
          second.id,
        ]),
      /request_ids/,
    );
  } finally {
    s.db.close();
  }
});

test("agent request chains cannot refresh the total turn budget", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work"),
      b = s.createAgent("B", "Work");
    let calls = 0;
    const h = new Harness(
      s,
      () => {},
      async (messages) => {
        calls++;
        const ctx = JSON.parse(messages[1].content);
        return response([
          {
            type: "direct",
            agent_id: ctx.you.id === a.id ? b.id : a.id,
            body: "Another question",
            requires_reply: true,
          },
        ]);
      },
    );
    h.start([a.id], "Ask", 1);
    await settle(h);
    assert.equal(calls, 1);
    assert.equal(h.requests[0].waiting_for_budget, true);
    h.scheduleRequests();
    await settle(h);
    assert.equal(calls, 1);
  } finally {
    s.db.close();
  }
});

test("chat history pages preserve every message and enforce membership", () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work"),
      b = s.createAgent("B", "Work"),
      chat = s.createChat("Long", "self", [a.id]);
    const expected = [];
    for (let i = 0; i < 405; i++)
      expected.push(s.send(chat.id, a.id, "message " + i).id);
    const recent = s.snapshot().chats[0];
    let before = recent.next_before,
      ids = recent.messages.map((m) => m.id);
    s.send(chat.id, a.id, "Concurrent new message");
    while (before) {
      const page = s.messagePage(chat.id, { before, limit: 100 }, a.id);
      ids = [...page.messages.map((m) => m.id), ...ids];
      before = page.next_before;
    }
    assert.deepEqual(ids, expected);
    assert.throws(() => s.messagePage(chat.id, {}, b.id), /unavailable/);
    assert.throws(() => s.messagePage(chat.id, { before: 0 }), /cursor/);
  } finally {
    s.db.close();
  }
});
