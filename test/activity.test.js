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
