import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects } from "../src/projects.js";
const dir = mkdtempSync(join(tmpdir(), "relay-uv-gemma-"));
const projects = new Projects(dir);
try {
  const p = projects.create("Gemma uv test");
  const { store, workspace, harness } = projects.get(p.id);
  workspace.configureEnvironment({ use_uv: true, allow_package_install: true });
  const a = store.createAgent(
    "Environment tester",
    'You verify the project uv environment. Write pyproject.toml with project name uv-check, version 0.1.0, requires-python >=3.12, and dependencies ["idna==3.10"]. Then call uv_sync. After receiving its successful result, call uv_run with args ["python","-c","import idna,sys; assert sys.prefix == \'/workspace/.venv\'; assert idna.__version__ == \'3.10\'; print(\'GEMMA_UV_PASSED\')"]. Read the result and finish. Do not create other agents or chats except your self notes. Use only the requested source file and tools; do not repeat successful steps.',
  );
  harness.start(
    [a.id],
    "Verify isolated per-project uv dependencies using the instructions in your role.",
    8,
  );
  while (harness.run.status === "running")
    await new Promise((r) => setTimeout(r, 500));
  const runs = workspace.runs();
  console.log(
    JSON.stringify(
      {
        status: harness.run.status,
        turns: harness.run.turns,
        executions: runs.map((r) => ({
          action: r.uv_action,
          status: r.status,
          stdout: r.stdout,
          stderr: r.stderr,
        })),
        errors: harness.history.filter((h) => h.status === "error"),
      },
      null,
      2,
    ),
  );
  assert.ok(
    runs.some((r) => r.uv_action === "sync" && r.status === "succeeded"),
  );
  assert.ok(
    runs.some(
      (r) =>
        r.uv_action === "run" &&
        r.status === "succeeded" &&
        r.stdout.includes("GEMMA_UV_PASSED") &&
        r.actor === a.id,
    ),
  );
  assert.ok(workspace.read("uv.lock").git_commit);
} finally {
  projects.close();
  rmSync(dir, { recursive: true, force: true });
}
