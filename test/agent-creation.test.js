import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";

test("agent creation defaults off and settings are validated and persisted", () => {
  const s = new Store(),
    a = s.createAgent("Lead", "Lead"),
    h = new Harness(s);
  const run = (h.run = { status: "running", ids: [a.id] });
  assert.throws(
    () =>
      h.createTeammate(
        a.id,
        { name: "Test", prompt: "Test", task: "Test" },
        run,
      ),
    /disabled/,
  );
  assert.equal(s.agents().length, 1);
  assert.throws(
    () => h.configure({ allow_agent_creation: true, max_new_agents: 11 }),
    /1–10/,
  );
  h.configure({ allow_agent_creation: true, max_new_agents: 2 });
  assert.equal(new Harness(s).settings.max_new_agents, 2);
  s.db.close();
});

test("new teammates participate, receive a direct task, and cannot see creator private notes", async () => {
  const s = new Store(),
    lead = s.createAgent("Lead", "Coordinate");
  const secret = s.createChat("Secret", "self", [lead.id]);
  s.send(secret.id, lead.id, "PRIVATE_CREATOR_SENTINEL");
  let childContext,
    childId,
    calls = 0;
  const h = new Harness(
    s,
    () => {},
    async (messages) => {
      const context = JSON.parse(messages[1].content);
      calls++;
      if (context.you.id === lead.id && calls > 1)
        return JSON.stringify({
          working_note: { name: "Plan", body: "Received the test report." },
          actions: [
            {
              type: "finish",
              summary:
                "Completed the fixture task; see the delivered result and evidence.",
            },
          ],
        });
      if (context.you.id === lead.id)
        return JSON.stringify({
          working_note: { name: "Plan", body: "Delegate testing." },
          actions: [
            {
              type: "create_agent",
              name: "Tester",
              prompt: "Test carefully",
              task: "Inspect the shared files and report.",
            },
            {
              type: "finish",
              summary:
                "Completed the fixture task; see the delivered result and evidence.",
            },
          ],
        });
      childContext = messages;
      childId = context.you.id;
      return JSON.stringify({
        working_note: { name: "Testing", body: "Read the delegated task." },
        actions: [
          { type: "reply", body: "Inspection complete." },
          {
            type: "finish",
            summary:
              "Completed the fixture task; see the delivered result and evidence.",
          },
        ],
      });
    },
  );
  h.configure({ allow_agent_creation: true, max_new_agents: 1 });
  h.start([lead.id], "Coordinate a test", 4);
  while (h.run.status === "running") await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 3);
  assert.equal(h.run.created_agents[0].created_by, lead.id);
  assert.ok(h.run.ids.includes(childId));
  assert.ok(!JSON.stringify(childContext).includes("PRIVATE_CREATOR_SENTINEL"));
  assert.ok(JSON.stringify(childContext).includes("Inspect the shared files"));
  assert.throws(() => s.requireMember(secret.id, childId), /unavailable/);
  assert.equal(s.chats(childId).filter((c) => c.kind === "self").length, 1);
  const audit = s
    .messages(s.chats(lead.id).find((c) => c.name === "Plan").id)
    .map((m) => m.body)
    .join("\n");
  assert.ok(!audit.includes("token"));
  assert.ok(audit.includes(childId));
  s.db.close();
});

test("creation limits apply across parents, duplicate names fail, and disabling takes effect immediately", () => {
  const s = new Store(),
    a = s.createAgent("Lead", "Lead"),
    h = new Harness(s);
  h.configure({ allow_agent_creation: true, max_new_agents: 1 });
  const run = (h.run = {
    status: "running",
    ids: [a.id],
    maxTurns: 5,
    turns: 1,
  });
  const child = h.createTeammate(
    a.id,
    { name: "Tester", prompt: "Test", task: "Test" },
    run,
  );
  assert.equal(child.token, undefined);
  assert.equal(run.maxTurns, 5);
  assert.throws(
    () =>
      h.createTeammate(
        a.id,
        { name: "tester", prompt: "Test", task: "Test" },
        run,
      ),
    /already exists/,
  );
  assert.throws(
    () =>
      h.createTeammate(
        child.agent_id,
        { name: "Grandchild", prompt: "Test", task: "Test" },
        run,
      ),
    /limit/,
  );
  h.configure({ allow_agent_creation: false, max_new_agents: 3 });
  assert.throws(
    () =>
      h.createTeammate(
        a.id,
        { name: "Other", prompt: "Test", task: "Test" },
        run,
      ),
    /disabled/,
  );
  assert.equal(s.agents().length, 2);
  s.db.close();
});
