import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
const fixture = () => {
  const s = new Store();
  return {
    s,
    a: s.createAgent("Atlas", "Coordinate"),
    b: s.createAgent("Nova", "Build"),
    c: s.createAgent("Sage", "Review"),
  };
};
test("private direct messages are inaccessible to a third agent", () => {
  const { s, a, b, c } = fixture();
  const chat = s.createChat(
    "Private",
    "direct",
    [a.id, b.id],
    a.id,
    "Architecture feedback",
  );
  s.send(chat.id, a.id, "Private design");
  assert.throws(() => s.messages(chat.id, c.id), /unavailable/);
  assert.throws(() => s.send(chat.id, c.id, "intrusion"), /unavailable/);
  assert.throws(() => s.addMember(chat.id, c.id, a.id), /cannot change/);
  assert.equal(
    s.snapshot(c.id).chats.some((x) => x.id === chat.id),
    false,
  );
  assert.equal(
    s.snapshot(b.id).agents.some((x) => "prompt" in x),
    false,
  );
  s.db.close();
});
test("group membership gates reads, sends, invites and summaries", () => {
  const { s, a, b, c } = fixture();
  const chat = s.createChat("Group", "group", [a.id, b.id], a.id);
  s.send(chat.id, a.id, "hello");
  assert.throws(() => s.addMember(chat.id, c.id, c.id));
  assert.throws(() => s.updateChat(chat.id, "leak", "leak", c.id));
  s.addMember(chat.id, c.id, a.id);
  assert.equal(s.messages(chat.id, c.id).length, 1);
  s.db.close();
});
test("multiple named self threads stay isolated", () => {
  const { s, a, b } = fixture();
  const planning = s.createChat(
    "Planning",
    "self",
    [a.id],
    a.id,
    "Next actions",
  );
  const research = s.createChat("Research", "self", [a.id], a.id, "Evidence");
  assert.notEqual(planning.id, research.id);
  s.send(planning.id, a.id, "Try option B");
  assert.throws(() => s.messages(planning.id, b.id));
  assert.throws(() => s.createChat("Invalid", "self", [a.id, b.id], a.id));
  assert.equal(
    s.snapshot(a.id).chats.filter((c) => c.kind === "self").length,
    2,
  );
  s.db.close();
});
test("read markers are independent, monotonic and do not advance when operator reads", () => {
  const { s, a, b } = fixture();
  const chat = s.createChat("DM", "direct", [a.id, b.id]);
  const m = s.send(chat.id, a.id, "new");
  s.snapshot();
  assert.equal(s.readState(chat.id, b.id).unread_count, 1);
  s.read(chat.id, b.id, m.id);
  assert.equal(s.readState(chat.id, b.id).unread_count, 0);
  s.read(chat.id, b.id, 0);
  assert.equal(s.readState(chat.id, b.id).last_read_id, m.id);
  s.send(chat.id, a.id, "new again");
  assert.equal(
    s.snapshot(b.id).chats.find((c) => c.id === chat.id).new_since_last_read
      .length,
    1,
  );
  assert.equal(s.readState(chat.id, a.id).unread_count, 0);
  s.db.close();
});
test("harness supplies isolated context and executes self-thread actions", async () => {
  const { s, a, b, c } = fixture();
  const dm = s.createChat("Secret", "direct", [a.id, b.id]);
  s.send(dm.id, a.id, "SECRET_SENTINEL");
  let seen;
  const h = new Harness(
    s,
    () => {},
    async (messages) => {
      seen = JSON.stringify(messages);
      return JSON.stringify({
        working_note: { name: "Planning", body: "Plan the next contribution." },
        actions: [
          { type: "self", name: "Experiments", summary: "Tests to run" },
          { type: "finish" },
        ],
      });
    },
  );
  h.start([c.id], "Think independently", 2);
  while (h.run.status === "running") await new Promise((r) => setTimeout(r, 5));
  assert.ok(!seen.includes("SECRET_SENTINEL"));
  assert.equal(
    s.chats(c.id).some((c) => c.name === "Experiments"),
    true,
  );
  assert.equal(h.run.status, "completed");
  s.db.close();
});
test("cancellation prevents a pending model response from sending", async () => {
  const { s, a } = fixture();
  let resolve;
  const h = new Harness(
    s,
    () => {},
    () => new Promise((r) => (resolve = r)),
  );
  h.start([a.id], "work", 2);
  h.stop();
  resolve(
    JSON.stringify({
      actions: [
        { type: "send", chat_id: "unused-after-stop", body: "too late" },
      ],
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.chats(a.id).length, 0);
  s.db.close();
});
test("group actions preserve initial messages and reuse matching groups", async () => {
  const { s, a, b } = fixture();
  const chat = s.createChat("Team", "group", [a.id, b.id]);
  const h = new Harness(
    s,
    () => {},
    async () =>
      JSON.stringify({
        working_note: { name: "Planning", body: "Plan the next contribution." },
        actions: [
          {
            type: "group",
            name: "Team",
            members: [b.id],
            body: "Concrete recommendation",
          },
          { type: "finish" },
        ],
      }),
  );
  h.start([a.id], "Contribute", 1);
  while (h.run.status === "running") await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.chats().filter((c) => c.kind === "group").length, 1);
  assert.equal(s.messages(chat.id)[0].body, "Concrete recommendation");
  s.db.close();
});

test("new workspaces and new agents have no predefined conversations", () => {
  const s = new Store();
  assert.deepEqual(s.snapshot(), { agents: [], chats: [] });
  s.createAgent("Writer", "Write a proposal");
  assert.equal(s.chats().length, 0);
  s.db.close();
});
test("actions without self working notes are rejected without side effects", async () => {
  const { s, a, b } = fixture();
  const h = new Harness(
    s,
    () => {},
    async () =>
      JSON.stringify({
        actions: [{ type: "direct", agent_id: b.id, body: "Should not send" }],
      }),
  );
  h.start([a.id], "Work", 1);
  while (h.run.status === "running") await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.chats().length, 0);
  assert.match(h.history[0].message, /working_note/);
  s.db.close();
});
test("working notes must be private and precede outbound actions", async () => {
  const { s, a, b } = fixture();
  const h = new Harness(
    s,
    () => {},
    async (messages) =>
      JSON.stringify(
        JSON.parse(messages[1].content).you.id === b.id
          ? {
              working_note: { name: "Review", body: "Read the request." },
              actions: [{ type: "finish" }],
            }
          : {
              working_note: {
                name: "Planning",
                summary: "Coordination",
                body: "Ask the specialist for input.",
              },
              actions: [
                { type: "direct", agent_id: b.id, body: "Please review." },
                { type: "finish" },
              ],
            },
      ),
  );
  h.start([a.id], "Coordinate", 2);
  while (h.run.status === "running") await new Promise((r) => setTimeout(r, 5));
  const own = s.chats(a.id).find((c) => c.kind === "self"),
    dm = s.chats(a.id).find((c) => c.kind === "direct");
  assert.ok(s.messages(own.id)[0].id < s.messages(dm.id)[0].id);
  assert.match(s.messages(own.id).at(-1).body, /Action results/);
  assert.equal(
    s.snapshot(b.id).chats.some((c) => c.id === own.id),
    false,
  );
  assert.equal(h.run.turns, 2);
  const bad = new Harness(
    s,
    () => {},
    async () =>
      JSON.stringify({
        working_note: { chat_id: dm.id, body: "Private note" },
        actions: [{ type: "send", chat_id: dm.id, body: "Must not send" }],
      }),
  );
  bad.start([a.id], "Work", 1);
  while (bad.run.status === "running")
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.messages(dm.id).length, 1);
  assert.match(bad.history[0].message, /private self chat/);
  s.db.close();
});
test("note-only turns reuse a named self thread across runs", async () => {
  const { s, a } = fixture();
  const h = new Harness(
    s,
    () => {},
    async () =>
      JSON.stringify({
        working_note: {
          name: "Investigation",
          summary: "Open questions",
          body: "Document the next experiment.",
        },
        actions: [],
      }),
  );
  for (let i = 0; i < 2; i++) {
    h.start([a.id], "Investigate", 1);
    while (h.run.status === "running")
      await new Promise((r) => setTimeout(r, 5));
  }
  const chats = s.chats(a.id);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].name, "Investigation");
  assert.equal(
    s.messages(chats[0].id).filter((m) => m.body.includes("Working note"))
      .length,
    2,
  );
  assert.equal(
    s.messages(chats[0].id).filter((m) => m.body.includes("Action results"))
      .length,
    2,
  );
  s.db.close();
});
