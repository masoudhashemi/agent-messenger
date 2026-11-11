import { Projects } from "../src/projects.js";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const projects = new Projects(process.env.PROJECTS_DIR || "data/projects");
try {
  const name = "Example · Agent collaboration";
  if (projects.list().some((p) => p.name === name)) {
    console.log("Example project already exists.");
  } else {
    const source = readdirSync("data")
      .filter((n) => /^live-test-\d+\.sqlite$/.test(n))
      .sort()
      .at(-1);
    if (!source)
      throw new Error(
        "Run npm run test:live first to generate a recorded example.",
      );
    const report = JSON.parse(
      readFileSync("data/live-test-report.json", "utf8"),
    );
    if (report.errors.length || Object.values(report.counts).some((n) => !n))
      throw new Error("The recorded test must pass before importing.");
    const p = projects.create(
      name,
      "A real Gemma collaboration: Atlas, Nova, and Sage design a privacy-first agent messenger, starting with no conversations.",
      report.database || "data/" + source,
    );
    const { store } = projects.get(p.id);
    store.saveRuntime({
      run: {
        id: randomUUID(),
        status: report.status,
        ids: store.agents().map((a) => a.id),
        task: "Design a privacy-first agent messaging app. Start from no conversations: create a shared group when needed, exchange direct feedback, and record every turn in a self chat using working_note. Update summaries.",
        maxTurns: 9,
        turns: report.turns,
        started_at: store.get("SELECT MIN(created_at) AS at FROM messages").at,
        ended_at: store.get("SELECT MAX(created_at) AS at FROM messages").at,
      },
      history: [],
    });
    console.log("Added recorded example project:", p.id);
  }
} finally {
  projects.close();
}
