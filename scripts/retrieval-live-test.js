import assert from "node:assert/strict";
import { Projects } from "../src/projects.js";
import { writeFileSync } from "node:fs";
const directory = `data/retrieval-test-${Date.now()}`,
  projects = new Projects(directory);
const project = projects.create(
  "Retrieval integration test",
  "Verify focused context, scoped search, historical decisions and Python verification.",
);
const { store, workspace, harness } = projects.get(project.id);
const analyst = store.createAgent(
  "Analyst",
  "Resolve requests by searching the accessible records. For this retrieval test, your FIRST turn must call search_messages, search_files, and search_executions, each with query Lyra. On the next turn, read the original message, matching file lines and execution output returned by those searches before editing. Record citations and validate code in the Python sandbox. Never guess missing facts.",
);
const colleague = store.createAgent("Colleague", "Review decisions."),
  outsider = store.createAgent("Outsider", "Keep private notes.");
const archive = store.createChat(
  "Architecture archive",
  "direct",
  [analyst.id, colleague.id],
  null,
  "Old implementation decisions. Search original messages for details.",
);
const source = store.send(
  archive.id,
  colleague.id,
  "Signed-off Lyra decision: use threshold 73. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. This decision supersedes the earlier experimental configuration. Approval code LYRA-7391. Preserve this decision when fixing the configuration.",
);
for (let i = 0; i < 210; i++)
  store.send(
    archive.id,
    colleague.id,
    `Unrelated archival maintenance update ${i}.`,
  );
const secret = store.createChat("Confidential notebook", "self", [outsider.id]);
store.send(
  secret.id,
  outsider.id,
  "Lyra PRIVATE_FORBIDDEN_SENTINEL threshold 99999.",
);
workspace.write(
  "config.py",
  Array.from({ length: 220 }, (_, i) => "# Configuration note " + i).join(
    "\n",
  ) + "\nLYRA_THRESHOLD = 61\n",
  0,
);
workspace.record({
  id: "historical-check",
  path: "old_validation.py",
  actor: colleague.id,
  status: "failed",
  stdout: "",
  stderr: "Lyra validation failed: expected threshold 73, received 61.",
  exit_code: 1,
  started_at: new Date().toISOString(),
});
const room = store.createChat("Current review", "group", [
  analyst.id,
  colleague.id,
]);
store.send(
  room.id,
  null,
  "Find the signed-off Lyra threshold in the older conversation, inspect the current configuration and the historical validation failure, then correct config.py. Write and run verify_lyra.py to check the setting. Report the approval code and source message ID here. Use search_messages, search_files and search_executions, and read their original sources.",
);
const measurements = [];
const rawResponses = [];
let leaked = false;
harness.completion = async (messages, signal) => {
  const text = JSON.stringify(messages);
  if (text.includes("PRIVATE_FORBIDDEN_SENTINEL")) leaked = true;
  measurements.push(Buffer.byteLength(messages.map((m) => m.content).join("")));
  const raw = await harness.complete(messages, signal);
  rawResponses.push(raw);
  return raw;
};
harness.start(
  [analyst.id],
  "Resolve the operator request in Current review. Search historical records and source before making changes. Do not message other agents unless necessary; the source records already contain the answer.",
  12,
);
let turn = 0;
while (harness.run.status === "running") {
  if (turn !== harness.run.turns) {
    turn = harness.run.turns;
    console.log(
      JSON.stringify({
        turn,
        context: harness.contextUsage[analyst.id],
        files: workspace
          .list()
          .map((f) => ({ path: f.path, revision: f.revision })),
      }),
    );
  }
  await new Promise((r) => setTimeout(r, 500));
}
const actions = [];
for (const c of store.chats(analyst.id).filter((c) => c.kind === "self"))
  for (const m of store.messages(c.id)) {
    if (m.body.includes("· Action results\n"))
      try {
        actions.push(
          ...JSON.parse(m.body.split("\n").slice(1).join("\n")).map(
            (x) => x.action,
          ),
        );
      } catch {}
  }
const report = {
  project_id: project.id,
  directory,
  status: harness.run.status,
  turns: harness.run.turns,
  actions: [...new Set(actions)],
  max_context_bytes: Math.max(...measurements),
  private_content_leaked: leaked,
  files: workspace.list(),
  executions: workspace.runs().map((r) => ({
    path: r.path,
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
  })),
  errors: harness.history.filter((h) => h.status === "error"),
};
writeFileSync(
  "data/retrieval-live-raw.json",
  JSON.stringify(rawResponses, null, 2),
);
writeFileSync(
  "data/retrieval-live-report.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
try {
  assert.equal(leaked, false);
  assert.ok(Math.max(...measurements) <= 64000);
  for (const tool of [
    "search_messages",
    "search_files",
    "search_executions",
    "read_message",
    "read_file",
    "read_execution",
  ])
    assert.ok(actions.includes(tool), "Missing tool " + tool);
  assert.match(workspace.read("config.py").content, /LYRA_THRESHOLD\s*=\s*73/);
  assert.ok(
    workspace
      .runs()
      .some((r) => r.path === "verify_lyra.py" && r.status === "succeeded"),
  );
  assert.ok(
    store
      .messages(room.id)
      .some((m) => m.sender_id === analyst.id && m.body.includes("LYRA-7391")),
  );
} finally {
  projects.close();
}
