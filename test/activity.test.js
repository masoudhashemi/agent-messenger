import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { Retrieval } from "../src/retrieval.js";
const response = (actions) =>
  JSON.stringify({
    working_note: { name: "Notes", body: "Handle the task." },
    actions,
  });
async function settle(h) {
  for (let i = 0; i < 1000 && h.run.status === "running"; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.notEqual(h.run.status, "running");
}
test("live activity identifies focused chat, actual sending destination and clears at completion", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work"),
      b = s.createAgent("B", "Work"),
      source = s.createChat("Request", "direct", [a.id, b.id]),
      destination = s.createChat("Result", "self", [a.id]);
    let resolve;
    const observed = [];
    const h = new Harness(
      s,
      () => observed.push(structuredClone(h.state().activity)),
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.retrieval.focus(a.id, source.id);
    h.start([a.id], "Work", 2);
    assert.equal(h.state().activity[a.id].chat_id, source.id);
    assert.equal(h.state().activity[a.id].phase, "preparing");
    assert.equal(new Retrieval(s).overview(b.id).activity, undefined);
    resolve(
      response([
        { type: "send", chat_id: destination.id, body: "Result" },
        { type: "finish" },
      ]),
    );
    await settle(h);
    assert.ok(
      observed.some(
        (state) =>
          state[a.id]?.phase === "sending" &&
          state[a.id].chat_id === destination.id,
      ),
    );
    assert.deepEqual(h.state().activity, {});
  } finally {
    s.db.close();
  }
});
test("stopping a pending model call clears indicators and they are not restored on restart", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work");
    let resolve;
    const h = new Harness(
      s,
      () => {},
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.start([a.id], "Work", 2);
    assert.equal(h.state().activity[a.id].chat_id, null);
    h.stop();
    assert.deepEqual(h.state().activity, {});
    resolve(response([{ type: "finish" }]));
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(new Harness(s).state().activity, {});
  } finally {
    s.db.close();
  }
});
test("misspelled source ID is rejected before SQLite and corrected calls clear validation failure", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work"),
      chat = s.createChat("Sources", "self", [a.id]);
    const artifact_id = s.artifacts.save("fixture", {
      owner: a.id,
      chat_id: chat.id,
    });
    s.sources.save(
      artifact_id,
      [{ title: "Source", url: "https://example.com", snippet: "Evidence" }],
      { owner: a.id, chat_id: chat.id },
    );
    const sourceId = s.sources.list(a.id, { artifact_id }).results[0].source_id;
    const retrieval = new Retrieval(s);
    assert.throws(
      () =>
        retrieval.execute(a.id, {
          type: "read_source",
          "type-read_source-id": sourceId,
        }),
      /read_source.source_id is required/,
    );
    for (const source_id of [null, {}, [], 2, ""])
      assert.throws(
        () => retrieval.execute(a.id, { type: "read_source", source_id }),
        /read_source.source_id/,
      );
    let turn = 0;
    const h = new Harness(
      s,
      () => {},
      async () =>
        response(
          ++turn === 1
            ? [{ type: "read_source", "type-read_source-id": sourceId }]
            : turn === 2
              ? [{ type: "read_source", source_id: sourceId }]
              : [{ type: "finish" }],
        ),
    );
    const schema = h
      .responseSchema()
      .properties.actions.items.anyOf.find(
        (s) => s.properties.type.enum[0] === "read_source",
      );
    assert.ok(schema.required.includes("source_id"));
    h.start([a.id], "Read source", 4);
    await settle(h);
    assert.equal(turn, 3);
    assert.deepEqual(h.run.work[a.id].errors, {});
    assert.equal(h.run.completion.status, "checks_passed");
    assert.ok(!JSON.stringify(h.history).includes("cannot be bound"));
  } finally {
    s.db.close();
  }
});

test("failed write skips misleading handoff and reports status without leaking private details", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("Builder", "Work"),
      b = s.createAgent("Reviewer", "Review"),
      chat = s.createChat("Review request", "direct", [a.id, b.id]);
    const h = new Harness(
      s,
      () => {},
      async () =>
        response([
          {
            type: "write_file",
            path: "private-file.py",
            content: "private content",
          },
          {
            type: "direct",
            agent_id: b.id,
            body: "I created the file successfully",
          },
          { type: "finish" },
        ]),
    );
    h.retrieval.focus(a.id, chat.id);
    h.start([a.id], "Create file", 1);
    await settle(h);
    const shared = s
      .messages(chat.id)
      .map((m) => m.body)
      .join("\n");
    assert.match(shared, /an action failed/);
    assert.match(shared, /2 remaining action\(s\).*skipped/);
    assert.doesNotMatch(
      shared,
      /private-file|private content|expected_revision|created the file successfully/,
    );
    const audit = s
      .all(
        "SELECT m.body FROM messages m JOIN chats c ON c.id=m.chat_id WHERE c.kind='self'",
      )
      .map((m) => m.body)
      .join("\n");
    assert.match(audit, /expected_revision/);
    assert.match(audit, /"status": "skipped"/);
    assert.equal(h.history[0].status, "error");
    assert.equal(h.run.completion.status, "incomplete");
  } finally {
    s.db.close();
  }
});

test("failed execution status skips success message; later recovery can deliver", async () => {
  const { Workspace } = await import("../src/workspace.js");
  const { renderMessage } = await import("../public/format.js");
  const s = new Store();
  try {
    const a = s.createAgent("Builder", "Work"),
      b = s.createAgent("Reviewer", "Review"),
      chat = s.createChat("Task", "direct", [a.id, b.id]),
      unrelated = s.createChat("Unrelated", "group", [a.id, b.id]);
    let turn = 0,
      executions = 0;
    const h = new Harness(
      s,
      () => {},
      async () =>
        response(
          ++turn <= 2
            ? [
                { type: "run_python", path: "tests.py" },
                ...(turn === 1
                  ? [
                      {
                        type: "send",
                        chat_id: chat.id,
                        body: "Premature success",
                      },
                    ]
                  : []),
              ]
            : [
                {
                  type: "send",
                  chat_id: chat.id,
                  body: "Tests passed after retry",
                },
                { type: "finish" },
              ],
        ),
      {
        workspace: new Workspace(s),
        sandbox: {
          run: async () =>
            ++executions === 1
              ? { status: "timed_out" }
              : { status: "completed", exit_code: 0 },
        },
      },
    );
    h.retrieval.focus(a.id, chat.id);
    h.start([a.id], "Test", 4);
    await settle(h);
    const messages = s
      .messages(chat.id)
      .map((m) => m.body)
      .join("\n");
    assert.doesNotMatch(messages, /Premature success/);
    assert.match(messages, /an action failed/);
    assert.match(messages, /Tests passed after retry/);
    assert.equal(s.messages(unrelated.id).length, 0);
    assert.equal(
      h.run.completion.status,
      "checks_passed",
      JSON.stringify({ completion: h.run.completion, history: h.history }),
    );
    assert.deepEqual(h.run.work[a.id].errors, {});
    const html = renderMessage(
      "Turn 1 · Action results\n" +
        JSON.stringify([
          {
            action: "send",
            result: { status: "skipped", reason: "Earlier action failed" },
          },
        ]),
    );
    assert.match(html, /Action skipped/);
    assert.match(html, /Earlier action failed/);
    assert.doesNotMatch(html, /Action completed|✓/);
  } finally {
    s.db.close();
  }
});
