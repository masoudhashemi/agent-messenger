import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
const response = (
  actions = [
    {
      type: "finish",
      summary:
        "Completed the fixture task; see the delivered result and evidence.",
    },
  ],
) =>
  JSON.stringify({
    working_note: { name: "Work", body: "Handle the new message." },
    actions,
  });
async function settle(h) {
  for (let i = 0; i < 1000; i++) {
    if (h.run?.status !== "running" && !h.scheduled) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw Error("Harness did not settle");
}
function fixture() {
  const s = new Store();
  return {
    s,
    a: s.createAgent("A", "Help"),
    b: s.createAgent("B", "Help"),
    c: s.createAgent("C", "Help"),
  };
}
test("a new group message starts members automatically after completion", async () => {
  const { s, a, b, c } = fixture(),
    chat = s.createChat("Group", "group", [a.id, b.id]);
  const seen = [];
  const h = new Harness(
    s,
    () => {},
    async (messages) => {
      const ctx = JSON.parse(messages[1].content);
      seen.push(ctx);
      return response(
        ctx.incoming_requests.length
          ? [
              { type: "reply", body: "Request handled." },
              {
                type: "finish",
                summary:
                  "Completed the fixture task; see the delivered result and evidence.",
              },
            ]
          : undefined,
      );
    },
  );
  h.start([a.id], "Old task", 4);
  await settle(h);
  seen.length = 0;
  const m = s.send(chat.id, null, "New request");
  h.wake(m);
  await settle(h);
  assert.deepEqual(new Set(seen.map((x) => x.you.id)), new Set([a.id, b.id]));
  for (const id of [a.id, b.id]) {
    assert.ok(
      seen
        .find((x) => x.you.id === id)
        .incoming_requests.some((m) => m.body === "New request"),
    );
  }
  assert.equal(h.requests[0].status, "delivered");
  assert.equal(h.run.status, "completed");
  s.db.close();
});
test("private request content is never copied into an unrelated agent task", async () => {
  const { s, a, b, c } = fixture();
  const self = s.createChat("Private", "self", [b.id]);
  let resolve;
  const seen = [];
  const h = new Harness(
    s,
    () => {},
    async (messages) => {
      const ctx = JSON.parse(messages[1].content);
      seen.push(ctx);
      if (seen.length === 1) return new Promise((r) => (resolve = r));
      return response();
    },
  );
  h.start([a.id, c.id], "Public work", 6);
  h.wake(s.send(self.id, null, "PRIVATE_SENTINEL"));
  resolve(response());
  await settle(h);
  assert.ok(
    seen
      .filter((x) => x.you.id !== b.id)
      .every((x) => !JSON.stringify(x).includes("PRIVATE_SENTINEL")),
  );
  assert.ok(
    seen.some(
      (x) =>
        x.you.id === b.id && x.incoming_requests[0].body === "PRIVATE_SENTINEL",
    ),
  );
  s.db.close();
});
test("message arriving during final model call gets a new bounded run", async () => {
  const { s, a } = fixture();
  const self = s.createChat("Notes", "self", [a.id]);
  let resolve;
  const seen = [];
  const h = new Harness(
    s,
    () => {},
    async (messages) => {
      seen.push(JSON.parse(messages[1].content));
      return seen.length === 1 ? new Promise((r) => (resolve = r)) : response();
    },
  );
  h.start([a.id], "Old task", 1);
  h.wake(s.send(self.id, null, "Late request"));
  resolve(response());
  await settle(h);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].incoming_requests[0].body, "Late request");
  assert.equal(h.requests[0].status, "delivered");
  s.db.close();
});
test("finish cannot swallow a message arriving after its context snapshot", async () => {
  const { s, a } = fixture();
  const self = s.createChat("Notes", "self", [a.id]);
  let resolve;
  let calls = 0;
  const h = new Harness(
    s,
    () => {},
    async () => {
      calls++;
      return calls === 1 ? new Promise((r) => (resolve = r)) : response();
    },
  );
  h.start([a.id], "Work", 4);
  s.send(self.id, null, "New input during generation");
  resolve(response());
  await settle(h);
  assert.equal(calls, 2);
  s.db.close();
});
test("failed requests remain retryable and stop prevents automatic restart", async () => {
  const { s, a } = fixture(),
    self = s.createChat("Notes", "self", [a.id]);
  let calls = 0;
  const h = new Harness(
    s,
    () => {},
    async () => {
      calls++;
      throw Error("Model unavailable");
    },
  );
  h.run = { status: "completed", maxTurns: 1 };
  const m = s.send(self.id, null, "Please work");
  h.wake(m);
  await settle(h);
  assert.equal(calls, 1);
  assert.equal(h.requests[0].status, "error");
  h.completion = async () => response();
  h.wake(m);
  await settle(h);
  assert.equal(h.requests[0].status, "delivered");
  const count = h.history.length;
  h.wake(m);
  await settle(h);
  assert.equal(h.history.length, count);
  let resolve;
  h.completion = () => new Promise((r) => (resolve = r));
  h.wake(s.send(self.id, null, "Another request"));
  h.stop();
  resolve(response());
  await settle(h);
  assert.equal(h.run.status, "stopped");
  assert.equal(h.requests.at(-1).status, "cancelled");
  s.db.close();
});
