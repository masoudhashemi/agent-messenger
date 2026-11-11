import { Projects } from "../src/projects.js";
import { writeFileSync } from "node:fs";
const directory = `data/coding-test-${Date.now()}`;
const projects = new Projects(directory, () => {});
const p = projects.create(
  "Example · Python pair programming",
  "Two Gemma agents implement, review, edit, and test shared Python files in isolated containers.",
);
const { store, workspace, harness } = projects.get(p.id);
const builder = store.createAgent(
  "Builder",
  "You implement Python code. Create math_utils.py implementing mean(values): return the arithmetic mean, and raise ValueError for empty input. Coordinate with Reviewer via direct chat. Ask Reviewer to improve the function docstring using edit_file and write/run unittest tests. Do not create test files yourself. Read feedback and fix problems. Keep concise working notes.",
);
const reviewer = store.createAgent(
  "Reviewer",
  "You review and test shared Python code. Once Builder creates math_utils.py, read it, add or improve a docstring with edit_file using the current revision, create test_math_utils.py using unittest, and run it with run_python. Cover integers, negative values, fractional values, and empty input. Privately report results to Builder. If files are not ready, ask Builder and work on tests. Record your working note every turn.",
);
harness.start(
  [builder.id, reviewer.id],
  "Implement and test mean(values) together. Builder owns initial math_utils.py; Reviewer edits its docstring, creates test_math_utils.py and executes it. Collaborate via direct messages. Finish after tests pass.",
  10,
);
let turn = -1;
while (harness.run.status === "running") {
  if (harness.run.turns !== turn) {
    turn = harness.run.turns;
    console.log(
      JSON.stringify({
        turn,
        files: workspace
          .list()
          .map((f) => ({ path: f.path, revision: f.revision })),
        executions: workspace
          .runs()
          .map((r) => ({ status: r.status, path: r.path })),
      }),
    );
  }
  await new Promise((r) => setTimeout(r, 500));
}
const report = {
  directory,
  project_id: p.id,
  database: `${directory}/${p.id}.sqlite`,
  status: harness.run.status,
  files: workspace.list(),
  executions: workspace
    .runs()
    .map((r) => ({
      status: r.status,
      actor: r.actor,
      path: r.path,
      stdout: r.stdout,
      stderr: r.stderr,
    })),
  errors: harness.history.filter((h) => h.status === "error"),
};
writeFileSync("data/coding-live-report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const passed =
  workspace.list().some((f) => f.path === "math_utils.py" && f.revision >= 2) &&
  workspace
    .runs()
    .some((r) => r.status === "succeeded" && r.actor === reviewer.id);
projects.close();
if (!passed) process.exitCode = 1;
