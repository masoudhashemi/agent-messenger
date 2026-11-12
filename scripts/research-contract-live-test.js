import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Projects } from "../src/projects.js";

const directory = mkdtempSync(join(tmpdir(), "relay-research-contract-"));
const projects = new Projects(directory);
try {
  const p = projects.create("Research contract integration test");
  const { store, harness, workspace } = projects.get(p.id);
  const agent = store.agents()[0];
  store.setAgentTools(agent.id, ["web_search"]);
  const marker = "OBSERVATION_" + randomUUID();
  // Configured model, deterministic search fixture: no claims of real-world research.
  harness.webSearch.execute = async () => ({
    query: "fixture",
    provider: "test fixture",
    results: [
      {
        title: "Synthetic research evidence",
        url: "https://example.com/evidence",
        snippet:
          `This is a synthetic test source, not a historical fact. The observation code is ${marker}.\n` +
          "Supporting fixture detail 😀\n".repeat(3000),
      },
    ],
  });
  harness.start(
    [agent.id],
    "Test the research workflow using a synthetic source. Search once with web_search, inspect the source index and read_source, then write reports/findings.md containing the observation code from the source, its citation URL, and the limitation that this is synthetic evidence. Use reply to deliver the report path and a cited finding to the operator. Finish with a summary. Do not invent the observation code or delegate. All fixtures are explicitly synthetic.",
    10,
    ["reports/findings.md"],
  );
  let previous = -1;
  while (harness.run.status === "running") {
    if (previous !== harness.run.turns) {
      previous = harness.run.turns;
      console.log(
        harness.run.model?.name || "Configured model",
        "research-contract turn",
        previous,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(
    harness.run.completion.status,
    "checks_passed",
    JSON.stringify(harness.history.filter((h) => h.status === "error")),
  );
  const report = workspace.read("reports/findings.md");
  assert.ok(report.content.includes(marker));
  assert.ok(report.content.includes("https://example.com/evidence"));
  assert.ok(store.get("SELECT count(*) AS n FROM source_reads").n > 0);
  assert.ok(store.chats(agent.id).some((c) => c.name === "Results"));
  console.log(
    "PASS: configured model retrieved indexed evidence, wrote the required report, delivered a cited reply, and passed completion checks.",
  );
} finally {
  projects.close();
  rmSync(directory, { recursive: true, force: true });
}
