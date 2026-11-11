import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Projects } from "../src/projects.js";
const directory = `data/agent-creation-test-${Date.now()}`;
const projects = new Projects(directory);
try {
  const project = projects.create("Agent creation integration test");
  const { store, harness, workspace } = projects.get(project.id);
  const lead = store.createAgent(
    "Coordinator",
    "You delegate one concrete task to one specialist. On your first turn use create_agent to create Python Tester with a system prompt instructing it to write checks/smoke.py containing an assertion that sum([2,3]) == 5 and print TEAMMATE_TEST_PASSED, run it using run_python, read the result, and report back in the direct delegation chat. Give it this exact task. Do not perform the task yourself. After creation, wait for its report; do not create any more agents. When the test passes, finish.",
  );
  const secret = store.createChat("Private planning", "self", [lead.id]);
  store.send(secret.id, lead.id, "CREATOR_ONLY_SECRET_8429");
  harness.configure({ allow_agent_creation: true, max_new_agents: 1 });
  let childCalls = 0;
  harness.completion = async (messages, signal) => {
    const ctx = JSON.parse(messages[1].content);
    if (ctx.you.id !== lead.id) {
      childCalls++;
      assert.ok(!JSON.stringify(messages).includes("CREATOR_ONLY_SECRET_8429"));
    }
    return harness.complete(messages, signal);
  };
  harness.start(
    [lead.id],
    "Delegate a Python smoke test to a newly created specialist and obtain real sandbox execution evidence. Stop after the specialist reports success.",
    12,
  );
  while (harness.run.status === "running")
    await new Promise((r) => setTimeout(r, 500));
  const report = {
    directory,
    project_id: project.id,
    status: harness.run.status,
    turns: harness.run.turns,
    agents: store.agents().map((a) => ({ id: a.id, name: a.name })),
    created: harness.run.created_agents,
    child_calls: childCalls,
    executions: workspace
      .runs()
      .map((r) => ({
        status: r.status,
        path: r.path,
        stdout: r.stdout,
        stderr: r.stderr,
      })),
    errors: harness.history.filter((h) => h.status === "error"),
  };
  writeFileSync(
    "data/agent-creation-live-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  assert.equal(store.agents().length, 2);
  assert.equal(harness.run.created_agents.length, 1);
  assert.ok(childCalls > 0);
  assert.ok(
    workspace
      .runs()
      .some(
        (r) =>
          r.status === "succeeded" && r.stdout.includes("TEAMMATE_TEST_PASSED"),
      ),
  );
  const child = harness.run.created_agents[0].id;
  assert.ok(
    store
      .chats(child)
      .filter((c) => c.kind === "direct")
      .some((c) =>
        store
          .messages(c.id)
          .some((m) => m.sender_id === child && /pass|success/i.test(m.body)),
      ),
  );
} finally {
  projects.close();
}
