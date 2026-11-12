import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Projects } from "../src/projects.js";
const directory = mkdtempSync(join(tmpdir(), "relay-group-live-"));
const projects = new Projects(directory);
try {
  const p = projects.create("Group workflow test");
  const { store, workspace, harness } = projects.get(p.id);
  const lead = store.updateAgent(store.agents()[0].id, {
    prompt:
      "Coordinate a small format decision. Use the shared group to gather both reviewers' findings, then record an accepted decision citing their GROUP message IDs as evidence. Write report.md, post the final synthesis in the group using reply, and resolve the group via update_group with final_message_id and deliverables:[report.md]. Read the group when you need the message IDs. Wait until reviewers finish before resolving. Finish with a summary. Do not recruit more agents or search the web.",
  });
  const reviewers = [
    store.createAgent(
      "Readability reviewer",
      "Recommend Markdown for readable headings. Send one concise recommendation to work_contract.shared_group_id, then finish with a summary. If awakened by later reports, simply finish; do not send repeated acknowledgements. Do not create agents or change group settings.",
    ),
    store.createAgent(
      "Portability reviewer",
      "Compare plain text portability with Markdown readability. Send one concise recommendation and a caveat to work_contract.shared_group_id, then finish with a summary. If awakened again, simply finish; do not repeat acknowledgements. Do not create agents or change group settings.",
    ),
  ];
  assert.equal(store.chats().length, 0);
  harness.start(
    [lead.id, ...reviewers.map((a) => a.id)],
    "As a team, decide whether our report should use Markdown or plain text. Share the tradeoffs in the automatically provided group, record the decision with message evidence, write report.md, and publish the final group report. The lead resolves the group; everyone finishes with a summary.",
    24,
    ["report.md"],
  );
  let lastTurn = -1;
  while (harness.run.status === "running") {
    if (lastTurn !== harness.run.turns) {
      lastTurn = harness.run.turns;
      console.log("Model group turn", lastTurn);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const group = store.chat(harness.run.shared_group_id);
  const report = {
    model: harness.run.model?.name,
    elapsed_seconds:
      (Date.parse(harness.run.ended_at) - Date.parse(harness.run.started_at)) /
      1000,
    turns: harness.run.turns,
    run_status: harness.run.status,
    completion: harness.run.completion.status,
    group_status: group.group.status,
    decisions: store.groups
      .decisions(group.id, lead.id)
      .results.map((d) => ({ status: d.status, evidence: d.evidence })),
    errors: harness.history.filter((h) => h.status === "error"),
  };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(group.group.status, "resolved");
  assert.ok(group.group.final_message_id);
  assert.ok(
    report.decisions.some((d) => d.status === "accepted" && d.evidence.length),
  );
  assert.ok(workspace.read("report.md").content.length > 0);
  assert.equal(harness.run.completion.status, "checks_passed");
  console.log(
    "PASS: configured model team discussed, recorded evidence-backed decision, wrote report, and resolved the shared group.",
  );
} finally {
  projects.close();
  rmSync(directory, { recursive: true, force: true });
}
