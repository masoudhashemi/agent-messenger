// Run against the local app. Profiles and results stay in ignored local data.
// Usage: node --env-file-if-exists=.env scripts/compare-models.js configs/model.toml configs/model-qwen.local.toml
import { modelConfig } from "../src/model-config.js";
import { publicModel, validateModel } from "../src/models.js";
import { mkdirSync, writeFileSync } from "node:fs";

const matchFirst = process.argv.includes("--match-first");
const files = process.argv.slice(2).filter((arg) => arg !== "--match-first");
if (files.length < 2)
  throw new Error("Pass at least two local TOML model configurations");
const base = process.env.RELAY_URL || "http://localhost:3210";
const home = await fetch(base);
const cookie = home.headers.get("set-cookie")?.split(";")[0] || "";
async function api(path, body, project) {
  const r = await fetch(
    base +
      "/api/admin/" +
      path +
      (project ? "?project=" + encodeURIComponent(project) : ""),
    {
      headers: {
        cookie,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    },
  );
  const result = await r.json();
  if (!r.ok) throw new Error(result.error);
  return result;
}
const task =
  "Research the most influential effects of the Qajar dynasty on Iran. Produce reports/qajar-findings.md (roughly 600–900 words) with political/diplomatic, socio-economic, and cultural/institutional findings, exact source URLs, disagreements, and evidence limitations. Each specialist should search and read relevant sources, share a concise cited handoff in the shared group, and send one targeted direct question or review to a colleague when useful. The lead synthesizes and records at least one evidence-backed decision, publishes the final report in the shared group, and resolves it after contributor handoffs. Avoid repetitive acknowledgments. All work starts from empty chats and files; keep working notes in self chats. Do not recruit extra agents. Everyone finishes with a summary, or a specific blocked reason.";
const roles = [
  [
    "Political & Diplomatic Historian",
    "Research political/diplomatic effects, territorial treaties and sovereignty. Distinguish evidence from interpretation.",
  ],
  [
    "Socio-Economic Analyst",
    "Research economic concessions, social changes and fiscal institutions. Challenge overbroad causal claims.",
  ],
  [
    "Cultural & Institutional Researcher",
    "Research education, cultural change and constitutional institutions. Identify long-term effects and uncertainties.",
  ],
];
const runs = [];
mkdirSync("data/model-comparisons", { recursive: true });
const output = "data/model-comparisons/" + Date.now() + ".json";
process.env.MODEL_CONFIG = files[0];
const baseline = publicModel(validateModel(modelConfig()));
const controlledFields = [
  "max_tokens",
  "context_window_tokens",
  "timeout_seconds",
  "temperature",
  "output_mode",
  "token_parameter",
  "extra_body",
];
const shared = Object.fromEntries(
  controlledFields
    .filter((k) => baseline[k] !== undefined)
    .map((k) => [k, baseline[k]]),
);
const conditions = {
  execution: "sequential",
  matched_configuration: matchFirst,
  shared: matchFirst ? shared : null,
  turn_budget: 28,
};
const persist = () =>
  writeFileSync(output, JSON.stringify({ task, conditions, runs }, null, 2));
for (const file of files) {
  const active = (await api("projects")).filter(
    (p) => p.run?.status === "running",
  );
  if (active.length)
    throw new Error(
      "Other project runs are active; finish them before running a sequential comparison.",
    );
  process.env.MODEL_CONFIG = file;
  const config = { ...modelConfig(), ...(matchFirst ? shared : {}) };
  const profile = await api("models", {
    ...publicModel(config),
    label: config.name + (matchFirst ? " · matched settings" : ""),
  });
  const project = await api("projects", {
    name:
      config.name +
      (matchFirst ? " · Qajar matched settings" : " · Qajar comparison"),
    summary: task,
  });
  await api("model", { id: profile.id }, project.id);
  const initial = await api("state", undefined, project.id);
  const lead = initial.agents[0];
  await api(
    "agent-details",
    {
      agent_id: lead.id,
      name: "Lead",
      prompt:
        "Coordinate the historical research. Share the synthesis and final report in the team group, integrate the specialists' evidence, record decisions with sources, write the required report, and resolve the group after contributor handoffs. Do not repeat completed work.",
      tools: ["web_search"],
    },
    project.id,
  );
  for (const [name, prompt] of roles)
    await api(
      "agents",
      {
        name,
        prompt:
          prompt +
          " Deliver cited findings to the shared group, answer targeted questions, and finish once your handoff is delivered. Do not keep acknowledging later reports.",
        tools: ["web_search"],
      },
      project.id,
    );
  const state = await api("state", undefined, project.id);
  await api(
    "run",
    {
      ids: state.agents.map((a) => a.id),
      task,
      maxTurns: 28,
      required_files: ["reports/qajar-findings.md"],
    },
    project.id,
  );
  runs.push({
    id: project.id,
    model: config.name,
    configuration: publicModel(profile),
    started_at: new Date().toISOString(),
  });
  console.log(
    JSON.stringify({
      project_id: project.id,
      model: config.name,
      status: "started",
    }),
  );
  while (runs.some((r) => !r.result)) {
    for (const run of runs.filter((r) => !r.result)) {
      const s = await api("state", undefined, run.id);
      if (run.turns !== s.run.turns) {
        run.turns = s.run.turns;
        run.effective_context_budget_bytes = s.run.context_budget_bytes;
        console.log(run.model, "turn", run.turns, s.run.status);
      }
      if (s.run.status !== "running") {
        run.result = {
          configuration: s.run.model,
          status: s.run.status,
          completion: s.run.completion,
          turns: s.run.turns,
          elapsed_seconds:
            (Date.parse(s.run.ended_at) - Date.parse(s.run.started_at)) / 1000,
          errors: s.history.filter((h) => h.status === "error"),
          conversations: s.chats.map((c) => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            messages: c.messages.length,
            status: c.group?.status,
          })),
          files: s.coding.files.map((f) => ({
            path: f.path,
            revision: f.revision,
          })),
        };
        console.log(
          JSON.stringify({ model: run.model, ...run.result }, null, 2),
        );
      }
    }
    persist();
    if (runs.some((r) => !r.result))
      await new Promise((r) => setTimeout(r, 3000));
  }
}
console.log("Comparison report:", output);
