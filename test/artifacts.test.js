import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { ExecutionOutput } from "../src/execution-output.js";
import { Retrieval } from "../src/retrieval.js";
import { Workspace } from "../src/workspace.js";
function readAll(store, id, actor) {
  let text = "",
    offset = 0;
  do {
    const page = store.artifacts.read(id, actor, { offset });
    text += page.text;
    offset = page.next_offset;
  } while (offset !== null);
  return text;
}
test("execution search finds terms across stored chunks and streams with continuations", () => {
  const s = new Store();
  try {
    const w = new Workspace(s),
      r = new Retrieval(s, w);
    const a = s.createAgent("Reader", "Inspect outputs");
    const stdout = "x".repeat(16380) + "BoundaryNeedle" + "y".repeat(40000);
    for (const id of ["first", "second"]) {
      w.record({
        id,
        path: "test.py",
        status: "failed",
        stdout: "",
        stderr: "",
        stdout_artifact_id: s.artifacts.save(stdout),
        stderr_artifact_id: s.artifacts.save("OtherStreamTerm"),
      });
    }
    const action = {
      type: "search_executions",
      query: "boundaryneedle otherstreamterm",
      limit: 1,
    };
    const first = r.execute(a.id, action);
    assert.equal(first.results.length, 1);
    assert.ok(first.results[0].snippet.includes("BoundaryNeedle"));
    assert.equal(first.results[0].stream, "stdout");
    const second = r.execute(a.id, { ...action, offset: first.next_offset });
    assert.equal(second.results.length, 1);
    assert.notEqual(first.results[0].id, second.results[0].id);
    assert.equal(second.next_offset, null);
    assert.equal(
      r.execute(a.id, { ...action, query: "missing" }).results.length,
      0,
    );
  } finally {
    s.db.close();
  }
});
test("artifacts reconstruct exactly across pages and restart, enforce chat ACL and search chunk boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-artifact-"));
  let s = new Store(join(dir, "state.sqlite"));
  try {
    const a = s.createAgent("A", "Work"),
      b = s.createAgent("B", "Work");
    const chat = s.createChat("Private", "self", [a.id]);
    const id = s.artifacts.create({
      owner: a.id,
      chat_id: chat.id,
      label: "Large result",
    });
    const text = '😀é\\"\n'.repeat(20000) + "END";
    s.artifacts.append(id, text.slice(0, 10001));
    s.artifacts.append(id, text.slice(10001));
    s.artifacts.finish(id);
    assert.equal(readAll(s, id, a.id), text);
    assert.throws(() => readAll(s, id, b.id), /unavailable/);
    assert.throws(() => s.artifacts.append(id, "x"), /unavailable/);
    const hits = s.artifacts.search(id, a.id, { query: "END" });
    assert.equal(hits.matches[0].offset, text.length - 3);
    s.db.close();
    s = new Store(join(dir, "state.sqlite"));
    assert.equal(readAll(s, id, a.id), text);
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("execution capture preserves long Unicode stdout and stderr across arbitrary byte boundaries", () => {
  const s = new Store();
  try {
    const capture = new ExecutionOutput(s.artifacts, "test");
    const text = "😀α漢字\n".repeat(20000),
      buffer = Buffer.from(text);
    for (let i = 0; i < buffer.length; i += 1111)
      capture.append("stdout", buffer.subarray(i, i + 1111));
    capture.append("stderr", Buffer.from("error\n".repeat(12000)));
    const result = capture.finish();
    assert.equal(readAll(s, result.stdout_artifact_id), text);
    assert.equal(
      readAll(s, result.stderr_artifact_id),
      "error\n".repeat(12000),
    );
    assert.equal(result.output_complete, true);
    assert.equal(result.stdout, "");
    assert.ok(!result.output_truncated);
  } finally {
    s.db.close();
  }
});
test("large optional results are saved before context selection and remain retrievable by their owner", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work", ["web_search"]);
    let count = 0;
    const full = {
      query: "q",
      provider: "fixture",
      results: [
        {
          title: "long",
          url: "https://example.com",
          snippet: "body".repeat(20000),
        },
      ],
    };
    const h = new Harness(
      s,
      () => {},
      async (messages) => {
        const context = JSON.parse(messages[1].content);
        if (++count === 2) {
          const r = context.previous_action_results[0];
          assert.equal(r.content_loaded, false);
          assert.deepEqual(JSON.parse(readAll(s, r.artifact_id, a.id)), full);
        }
        return JSON.stringify({
          working_note: { name: "Work", body: "Inspect output" },
          actions:
            count === 1
              ? [{ type: "web_search", query: "q" }]
              : count === 2
                ? [
                    {
                      type: "read_source",
                      source_id:
                        context.previous_action_results[0].sources.results[0]
                          .source_id,
                    },
                  ]
                : [
                    { type: "reply", body: "Evidence: https://example.com" },
                    {
                      type: "finish",
                      summary:
                        "Completed the fixture task; see the delivered result and evidence.",
                    },
                  ],
        });
      },
    );
    h.webSearch.execute = async () => full;
    h.start([a.id], "Work", 3);
    while (h.run.status === "running")
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(count, 3);
    assert.ok(!h.history.some((e) => e.status === "error"));
  } finally {
    s.db.close();
  }
});
test("diff pages reconstruct complete long lines and pin the revision across edits", () => {
  const s = new Store();
  try {
    const w = new Workspace(s),
      r = new Retrieval(s, w),
      a = s.createAgent("A", "Work");
    const old = "x".repeat(20000) + "\n",
      fresh = "😀".repeat(12000) + "\n";
    w.write("a.txt", old, 0, a.id);
    w.write("a.txt", fresh, 1, a.id);
    let action = { type: "read_file_diff", path: "a.txt", revision: 2 },
      removed = "",
      added = "";
    do {
      const result = r.execute(a.id, action);
      for (const row of result.results) {
        if (row.type === "removed") removed += row.text;
        if (row.type === "added") added += row.text;
      }
      action = result.next;
    } while (action);
    assert.equal(removed, old);
    assert.equal(added, fresh);
  } finally {
    s.db.close();
  }
});
