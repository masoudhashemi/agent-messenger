import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Projects } from "../src/projects.js";
import { Retrieval } from "../src/retrieval.js";

// A saved, inspectable integration example. Fixtures are explicitly identified;
// verification uses the production retrieval/sandbox paths and a real model.
const projects = new Projects(process.env.PROJECTS_DIR || "data/projects");
const fixtureOnly = process.argv.includes("--fixtures-only");
const project = projects.create(
  "Example · Complete output verification",
  "Large Unicode output, private artifacts, paginated reading, search, and long file diffs. Open Verification results for the test report.",
);
const { store, workspace, sandbox, harness } = projects.get(project.id);
const agent = store.updateAgent(store.agents()[0].id, {
  name: "Output verifier",
  prompt:
    "Verify the supplied output fixtures using retrieval tools. Read original evidence before reporting. Keep private progress notes in Verification notebook and post your final evidence in Verification results. Do not modify the fixtures or recruit agents. A source reference is not its contents.",
});
const observer = store.createAgent(
  "Privacy observer",
  "You are the access-control test subject. If a shared report wakes you, record a brief private acknowledgement and use finish only. Do not send messages, retrieve sources, or perform additional work. The example runner already tests that you cannot access the verifier's private artifact.",
);
const notebook = store.createChat(
  "Verification notebook",
  "self",
  [agent.id],
  null,
  "Private fixture artifact and real model retrieval audit.",
);
const room = store.createChat(
  "Verification results",
  "group",
  [agent.id, observer.id],
  null,
  "Automated preservation checks and the model's evidence report. Setup posts are from the example runner, not an agent.",
);
const report = {
  project_id: project.id,
  checks: [],
  model: { status: "not_run" },
};
const hash = (text) => createHash("sha256").update(text).digest("hex");
function collect(action) {
  let text = "",
    pages = 0;
  const retrieval = new Retrieval(store, workspace);
  do {
    const part = retrieval.execute(agent.id, action);
    text += part.text ?? part.body ?? part.output;
    pages++;
    action =
      part.next_offset === null
        ? null
        : { ...action, offset: part.next_offset };
  } while (action);
  return { text, pages };
}
function check(name, run) {
  const details = run() || {};
  report.checks.push({ name, status: "passed", ...details });
}
function saveReport() {
  const previous = workspace
    .list()
    .find((f) => f.path === "verification/report.json");
  workspace.write(
    "verification/report.json",
    JSON.stringify(report, null, 2) + "\n",
    previous?.revision || 0,
  );
}
try {
  console.log("Created example:", project.id);
  assert.equal(
    (await sandbox.status()).ready,
    true,
    "Docker and the configured Python image must be available",
  );
  const logMarker = "LOG_END_" + randomUUID();
  const toolMarker = "TOOL_END_" + randomUUID();
  const stdout = "Unicode log 😀 α 漢字\n".repeat(6000) + logMarker + "\n";
  const stderr = "Diagnostic é\n".repeat(4000) + "STDERR_END\n";
  workspace.write(
    "fixtures/emit_output.py",
    `import sys\nprint("Unicode log 😀 α 漢字\\n" * 6000 + ${JSON.stringify(logMarker)})\nsys.stderr.write("Diagnostic é\\n" * 4000 + "STDERR_END\\n")\n`,
    0,
  );
  const execution = await sandbox.run("fixtures/emit_output.py", [], 20);
  assert.equal(execution.status, "succeeded", execution.error);
  for (const [stream, expected] of [
    ["stdout", stdout],
    ["stderr", stderr],
  ]) {
    check(`Complete Docker ${stream} reconstruction`, () => {
      const read = collect({
        type: "read_execution",
        execution_id: execution.id,
        stream,
      });
      assert.equal(read.text, expected);
      assert.ok(read.pages > 1);
      return {
        characters: expected.length,
        pages: read.pages,
        sha256: hash(read.text),
      };
    });
    store.send(
      room.id,
      null,
      "Tool result\n" +
        JSON.stringify({
          artifact_id: execution[stream + "_artifact_id"],
          source: `Real Docker ${stream}`,
          content_loaded: false,
        }),
    );
  }
  const fixture = JSON.stringify({
    source: "Synthetic tool-response fixture (no external provider called)",
    text: 'Fixture payload 😀\\"\n'.repeat(5000),
    marker: toolMarker,
  });
  const artifact = store.artifacts.save(fixture, {
    owner: agent.id,
    chat_id: notebook.id,
    label: "Large synthetic tool response",
  });
  store.send(
    notebook.id,
    null,
    "Tool result\n" +
      JSON.stringify({
        artifact_id: artifact,
        content_loaded: false,
        read_with: { type: "read_artifact", artifact_id: artifact },
        fixture: true,
      }),
  );
  check("Complete private JSON artifact reconstruction", () => {
    const read = collect({ type: "read_artifact", artifact_id: artifact });
    assert.equal(read.text, fixture);
    assert.equal(JSON.parse(read.text).marker, toolMarker);
    return {
      pages: read.pages,
      characters: fixture.length,
      sha256: hash(read.text),
    };
  });
  check("Private artifact denied to another project agent", () => {
    assert.throws(
      () => store.artifacts.read(artifact, observer.id),
      (e) => e.status === 403 || /unavailable|member|access/i.test(e.message),
    );
  });
  check("Artifact search finds a marker beyond the first page", () => {
    const hit = store.artifacts.search(artifact, agent.id, {
      query: "TOOL_END_",
    }).matches[0];
    assert.ok(hit.offset > 32000);
    assert.ok(
      store.artifacts
        .read(artifact, agent.id, { offset: hit.offset })
        .text.includes(toolMarker),
    );
  });
  const longMessage =
    "Archived message detail 😀\n".repeat(3000) + "MESSAGE_END";
  const message = store.send(notebook.id, null, longMessage);
  check("Complete long message reconstruction", () => {
    const read = collect({ type: "read_message", message_id: message.id });
    assert.equal(read.text, longMessage);
    return { pages: read.pages, characters: longMessage.length };
  });
  const before = "old-".repeat(4000) + "OLD_END\n";
  const after = "new😀".repeat(4000) + "NEW_END\n";
  workspace.write("fixtures/long-line.txt", before, 0);
  workspace.write("fixtures/long-line.txt", after, 1);
  store.send(
    room.id,
    null,
    "Example runner created two fixture revisions to test long diff lines. Open the formatted diff below.",
  );
  store.send(
    room.id,
    null,
    "File change\n" +
      JSON.stringify({
        path: "fixtures/long-line.txt",
        revision: 2,
        kind: "modified",
      }),
  );
  check("Complete removed and added diff lines across pages", () => {
    const retrieval = new Retrieval(store, workspace);
    let action = {
        type: "read_file_diff",
        path: "fixtures/long-line.txt",
        revision: 2,
      },
      removed = "",
      added = "",
      pages = 0;
    do {
      const result = retrieval.execute(agent.id, action);
      for (const row of result.results) {
        if (row.type === "removed") removed += row.text;
        if (row.type === "added") added += row.text;
      }
      action = result.next;
      pages++;
    } while (action);
    assert.equal(removed, before);
    assert.equal(added, after);
    return { pages, before_sha256: hash(removed), after_sha256: hash(added) };
  });
  workspace.write(
    "START_HERE.md",
    `# Complete output verification\n\nOpen the **Verification results** group for automated checks, output links, and the real Gemma report. Setup messages and files are explicitly generated fixtures. **Verification notebook** contains the private synthetic tool result, long message, and model action audit. The Privacy observer cannot access that notebook. Shared reports may wake it to acknowledge privately and finish.\n\nOpen **View complete output** on a log, move between pages, search for LOG_END_ or STDERR_END, and download the full text. Search the private fixture for TOOL_END_. Open the formatted diff for fixtures/long-line.txt; the line endings OLD_END and NEW_END must remain visible.\n\nThe workspace contains fixtures/emit_output.py, fixtures/long-line.txt with two Git revisions, and verification/report.json with exact reconstruction checks and hashes. The model retrieves selected evidence; the automated checks reconstruct every page.\n\nRecreate and rerun from the application repository: npm run example:outputs\n`,
    0,
  );
  saveReport();
  store.send(
    room.id,
    null,
    `Automated checks: ${report.checks.length}/${report.checks.length} PASS. Full output was reconstructed and compared exactly, including Unicode, private JSON, a long message, and both long diff lines. Details: verification/report.json. Next, a real model will retrieve tail evidence using search and pagination.`,
  );
  if (!fixtureOnly) {
    const task = `Inspect this output preservation example. Keep notes in self chat ${notebook.id}. First use search_artifact on private artifact ${artifact} with query TOOL_END_, and on stdout artifact ${execution.stdout_artifact_id} with query LOG_END_. Read the returned offsets with read_artifact to recover both complete marker values; they are not supplied in this task. Also call read_execution on execution ${execution.id} stream stderr, then follow its next_offset for one more page. Call read_file_diff for fixtures/long-line.txt revision 2, and follow the full returned next action at least once. You need not read all log or diff pages: the automated checks already do that. Post both exact marker values and which continuation tools you used in group ${room.id}, then finish. Do not delegate or edit files.`;
    let maxContextBytes = 0;
    harness.completion = async (messages, signal) => {
      maxContextBytes = Math.max(
        maxContextBytes,
        Buffer.byteLength(messages.map((m) => m.content).join("")),
      );
      return harness.complete(messages, signal);
    };
    harness.start([agent.id], task, 14);
    let turn = -1;
    while (harness.run.status === "running") {
      if (turn !== harness.run.turns) {
        turn = harness.run.turns;
        console.log(`Gemma verification turn ${turn}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const replies = store
      .messages(room.id)
      .filter((m) => m.sender_id === agent.id)
      .map((m) => m.body)
      .join("\n");
    const audits = store
      .chats(agent.id)
      .filter((c) => c.kind === "self")
      .flatMap((c) => store.messages(c.id))
      .filter((m) => m.body.includes("· Action results\n"))
      .map((m) => m.body)
      .join("\n");
    report.model = {
      status: harness.run.status,
      turns: harness.run.turns,
      max_context_bytes: maxContextBytes,
      recovered_both_markers:
        replies.includes(logMarker) && replies.includes(toolMarker),
      retrieval_actions_present: [
        "search_artifact",
        "read_artifact",
        "read_execution",
        "read_file_diff",
      ].every(
        (type) =>
          audits.includes(`"action":"${type}"`) ||
          audits.includes(`"action": "${type}"`),
      ),
    };
    assert.equal(
      report.model.recovered_both_markers,
      true,
      "Model did not report both tail markers; inspect its saved audit",
    );
    assert.equal(
      report.model.retrieval_actions_present,
      true,
      "Model skipped a required retrieval tool",
    );
    assert.ok(maxContextBytes <= 64000, "Model context exceeded its budget");
    store.send(
      room.id,
      null,
      "PASS: real Gemma retrieved and reported both hidden tail markers, exercised the retrieval tools, and stayed within the context budget. Complete source output remains available above.",
    );
  }
  saveReport();
  console.log(
    JSON.stringify(
      {
        project_id: project.id,
        url: `http://localhost:3210/?project=${project.id}`,
        checks: report.checks.length,
        model: report.model,
      },
      null,
      2,
    ),
  );
} catch (error) {
  report.failure = error.message;
  saveReport();
  store.send(
    room.id,
    null,
    "Verification failed: " +
      error.message +
      ". Inspect verification/report.json and the notebook audit; this example is not marked as passing.",
  );
  console.error(error.message);
  process.exitCode = 1;
} finally {
  projects.close();
}
