import { mkdirSync, writeFileSync } from "node:fs";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
mkdirSync("data", { recursive: true });
const database = `data/live-test-${Date.now()}.sqlite`;
const s = new Store(database);
const agents = [
  s.createAgent(
    "Atlas",
    "Coordinate the team. Send Nova one private question, post a short plan to the shared group, and keep a concise plan in your self thread.",
  ),
  s.createAgent(
    "Nova",
    "You are the engineer. Read and answer private questions from Atlas. Post a concrete technical recommendation in the shared group. Keep concise working notes in a named self thread.",
  ),
  s.createAgent(
    "Sage",
    "You are the privacy reviewer. Post a concise privacy review in the group, privately send Atlas one specific risk, and use a self thread for a checklist.",
  ),
];
if (s.chats().length !== 0)
  throw new Error("Expected an empty conversation list");
const h = new Harness(s, () => {
  console.log(
    JSON.stringify({
      status: h.run?.status,
      turns: h.run?.turns,
      agents: s
        .agents()
        .filter((a) => agents.some((t) => t.id === a.id))
        .map((a) => ({ name: a.name, status: a.status, error: a.error })),
    }),
  );
});
h.start(
  agents.map((a) => a.id),
  "Design a privacy-first agent messaging app. Start from no conversations: create a shared group when needed, exchange direct feedback, and record every turn in a self chat using working_note. Update summaries.",
  9,
);
while (h.run.status === "running") await new Promise((r) => setTimeout(r, 500));
const snapshot = s.snapshot(),
  chats = snapshot.chats.filter((c) =>
    c.members.some((id) => agents.some((a) => a.id === id)),
  );
const counts = Object.fromEntries(
  ["group", "direct", "self"].map((kind) => [
    kind,
    chats
      .filter((c) => c.kind === kind)
      .reduce((n, c) => n + c.messages.filter((m) => m.sender_id).length, 0),
  ]),
);
const report = {
  database,
  status: h.run.status,
  turns: h.run.turns,
  counts,
  errors: h.history.filter((h) => h.status === "error"),
};
writeFileSync("data/live-test-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
s.db.close();
if (report.errors.length || Object.values(counts).some((n) => !n))
  process.exitCode = 1;
