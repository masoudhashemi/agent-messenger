import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { Workspace } from "../src/workspace.js";
import { Retrieval } from "../src/retrieval.js";
import { addReplyTarget } from "../src/work-contract.js";

const response = (actions) =>
  JSON.stringify({
    working_note: { name: "Work", body: "Perform the requested checks." },
    actions,
  });
const finish = {
  type: "finish",
  summary: "Results delivered with limitations and evidence references.",
};
async function settle(h) {
  for (let i = 0; i < 1000; i++) {
    if (h.run.status !== "running") return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw Error("Run did not finish");
}
test("failed delivery prevents finish across turns, corrected reply succeeds and audits retain destination", async () => {
  const s = new Store();
  try {
    const agent = s.createAgent("Lead", "Deliver results");
    let turn = 0;
    const h = new Harness(
      s,
      () => {},
      async () =>
        response(
          ++turn === 1
            ? [
                {
                  type: "send",
                  chat_id: "missing-chat",
                  body: "Result",
                  api_key: "audit-secret-fixture",
                },
                finish,
              ]
            : turn === 2
              ? [finish]
              : [{ type: "reply", body: "Recovered final result" }, finish],
        ),
    );
    h.start([agent.id], "Deliver", 4);
    await settle(h);
    assert.equal(turn, 3);
    assert.equal(h.run.completion.status, "checks_passed");
    const audits = s
      .chats(agent.id)
      .flatMap((c) => s.messages(c.id))
      .map((m) => m.body)
      .join("\n");
    assert.match(audits, /missing-chat/);
    assert.ok(!audits.includes("audit-secret-fixture"));
    assert.match(audits, /\[redacted\]/);
    assert.match(audits, /Resolve failed tools/);
    assert.ok(s.chats(agent.id).some((c) => c.name === "Results"));
  } finally {
    s.db.close();
  }
});
test("private working notes do not satisfy a required reply; summary updates after real delivery", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work"),
      chat = s.createChat("Request", "self", [a.id]);
    const request = s.send(chat.id, null, "Please answer here");
    let turn = 0;
    const h = new Harness(
      s,
      () => {},
      async () => {
        addReplyTarget(h.run, a.id, request);
        return response(
          ++turn === 1
            ? [finish]
            : [{ type: "reply", body: "Answer delivered" }, finish],
        );
      },
    );
    h.start([a.id], "Answer", 3);
    await settle(h);
    assert.equal(turn, 2);
    assert.equal(s.chat(chat.id).summary, finish.summary);
    assert.ok(s.messages(chat.id).some((m) => m.body === "Answer delivered"));
  } finally {
    s.db.close();
  }
});
test("missing required deliverable prevents success and explicit blockers remain distinguishable", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Write"),
      w = new Workspace(s);
    let turn = 0;
    const h = new Harness(
      s,
      () => {},
      async () =>
        response(
          ++turn === 1
            ? [finish]
            : [
                {
                  type: "write_file",
                  path: "report.md",
                  content: "Written report",
                  expected_revision: 0,
                },
                finish,
              ],
        ),
      { workspace: w },
    );
    h.start([a.id], "Write report", 3, ["report.md"]);
    await settle(h);
    assert.equal(turn, 2);
    assert.equal(h.run.completion.status, "checks_passed");
    let blockedTurn = 0;
    h.completion = async () =>
      response([
        ...(++blockedTurn === 1
          ? [{ type: "send", chat_id: "missing", body: "x" }]
          : []),
        {
          type: "finish",
          outcome: "blocked",
          reason: "Destination is unavailable",
        },
      ]);
    h.start([a.id], "Blocked example", 2);
    await settle(h);
    assert.equal(h.run.completion.status, "blocked");
    assert.equal(h.run.work[a.id].status, "blocked");
  } finally {
    s.db.close();
  }
});
test("source indexes preserve full data and ACLs; researched completion needs a retrieved citation", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Research", ["web_search"]),
      outsider = s.createAgent("B", "Observe");
    const source = {
      title: "Fixture",
      url: "https://example.com/evidence",
      snippet: "Complete 😀 evidence\n".repeat(10000),
    };
    let turn = 0,
      sourceId;
    const h = new Harness(
      s,
      () => {},
      async (messages) => {
        const context = JSON.parse(messages[1].content);
        turn++;
        if (turn === 1)
          return response([{ type: "web_search", query: "fixture" }]);
        if (turn === 2) {
          sourceId =
            context.previous_action_results[0].sources.results[0].source_id;
          assert.throws(
            () =>
              new Retrieval(s).execute(outsider.id, {
                type: "read_source",
                source_id: sourceId,
              }),
            /unavailable/,
          );
          return response([
            {
              type: "reply",
              body: "Unsupported claim https://example.com/evidence",
            },
            finish,
          ]);
        }
        if (turn === 3)
          return response([{ type: "read_source", source_id: sourceId }]);
        return response([
          {
            type: "reply",
            body: "Excerpt supports this finding: https://example.com/evidence",
          },
          finish,
        ]);
      },
    );
    h.webSearch.execute = async () => ({ results: [source], query: "fixture" });
    h.start([a.id], "Research", 5);
    await settle(h);
    assert.equal(turn, 4);
    assert.equal(h.run.completion.status, "checks_passed");
    assert.deepEqual(
      JSON.parse([...s.artifacts.chunks(sourceId, a.id)].join("")),
      source,
    );
    assert.equal(
      s.get("SELECT count(*) AS n FROM source_reads WHERE agent_id=?", a.id).n,
      1,
    );
  } finally {
    s.db.close();
  }
});
test("tool schemas and runtime errors identify invalid fields without clamping", () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Work"),
      r = new Retrieval(s),
      h = new Harness(s);
    assert.throws(
      () =>
        r.execute(a.id, { type: "read_chat", chat_id: "anything", limit: 50 }),
      /read_chat.limit must be an integer between 1 and 30/,
    );
    const constraint = h
      .responseSchema()
      .properties.actions.items.anyOf.find(
        (x) => x.properties.type.enum[0] === "read_chat",
      );
    assert.equal(constraint.properties.limit.maximum, 30);
  } finally {
    s.db.close();
  }
});
test("finish cannot precede later actions and failed execution results stay unresolved", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Run"),
      w = new Workspace(s);
    const h = new Harness(
      s,
      () => {},
      async () => response([{ type: "run_python", path: "x.py" }, finish]),
      {
        workspace: w,
        sandbox: {
          run: async () => ({ status: "failed", error: "Execution failed" }),
        },
      },
    );
    h.start([a.id], "Run", 1);
    await settle(h);
    assert.equal(h.run.completion.status, "incomplete");
    assert.ok(Object.values(h.run.work[a.id].errors).includes("run_python"));
    h.completion = async () =>
      response([finish, { type: "send", chat_id: "missing", body: "x" }]);
    h.start([a.id], "Bad order", 1);
    await settle(h);
    assert.equal(h.run.completion.status, "incomplete");
  } finally {
    s.db.close();
  }
});
test("retrieved_sources persist in work_contract across turns, 8-char prefixes resolve, and active teammates show working status", async () => {
  const s = new Store();
  try {
    const lead = s.createAgent("Lead", "Coordinate", ["web_search"]),
      peer = s.createAgent("Specialist", "Research", ["web_search"]);
    const source = {
      title: "Primary Evidence",
      url: "https://example.com/primary",
      snippet: "Verified historical excerpt.",
    };
    let turn = 0,
      fullSourceId,
      fullArtifactId,
      leadContextOnTurn3;
    const h = new Harness(
      s,
      () => {},
      async (messages) => {
        const ctx = JSON.parse(messages[1].content);
        turn++;
        if (turn === 1) {
          const peerEntry = ctx.context.agents.find((x) => x.id === peer.id);
          assert.equal(peerEntry.status, "working");
          return response([{ type: "web_search", query: "iran" }]);
        }
        if (turn === 2) {
          return response([
            { type: "reply", body: "Specialist update" },
            finish,
          ]);
        }
        if (turn === 3) {
          fullArtifactId = ctx.previous_action_results[0].artifact_id;
          fullSourceId =
            ctx.previous_action_results[0].sources.results[0].source_id;
          return response([
            { type: "read_source", source_id: fullSourceId.slice(0, 8) },
          ]);
        }
        if (turn === 4) {
          // Run another non-source action so previous_action_results rolls over on turn 5.
          return response([{ type: "list_chats" }]);
        }
        leadContextOnTurn3 = ctx;
        return response([
          {
            type: "reply",
            body: "Final report citing https://example.com/primary",
          },
          finish,
        ]);
      },
    );
    h.webSearch.execute = async () => ({ results: [source], query: "iran" });
    h.start([lead.id, peer.id], "Research", 6);
    await settle(h);
    assert.equal(h.run.completion.status, "checks_passed");
    assert.equal(
      leadContextOnTurn3.work_contract.retrieved_sources[0].source_id,
      fullSourceId,
    );
    assert.equal(
      leadContextOnTurn3.work_contract.retrieved_sources[0].url,
      "https://example.com/primary",
    );
    assert.ok(
      leadContextOnTurn3.work_contract.search_artifacts.includes(
        fullArtifactId,
      ),
    );
    assert.equal(
      leadContextOnTurn3.context.agents.find((x) => x.id === peer.id).status,
      "done",
    );
  } finally {
    s.db.close();
  }
});

test("resumed research keeps previously read evidence without sharing another agent's sources", async () => {
  const { workContext, completionProblems } =
    await import("../src/work-contract.js");
  const s = new Store();
  try {
    const a = s.createAgent("Researcher", "Research"),
      b = s.createAgent("Other", "Work");
    const chat = s.createChat("Notes", "self", [a.id]);
    const artifact = s.artifacts.save("fixture", {
      owner: a.id,
      chat_id: chat.id,
      label: "web_search",
    });
    s.sources.save(
      artifact,
      [
        {
          title: "Evidence",
          url: "https://example.com/prior",
          snippet: "Previously read evidence",
        },
      ],
      { owner: a.id, chat_id: chat.id },
    );
    const source = s.sources.list(a.id, { artifact_id: artifact }).results[0];
    new Retrieval(s).execute(a.id, {
      type: "read_source",
      source_id: source.source_id,
    });
    s.run("UPDATE source_reads SET created_at=?", "2020-01-01T00:00:00.000Z");
    const work = {
      reply_targets: [],
      required_files: [],
      errors: {},
      searched: true,
      deliveries: [],
      status: "working",
    };
    assert.equal(
      workContext(work, s, a.id, new Date().toISOString()).retrieved_sources[0]
        .source_id,
      source.source_id,
    );
    assert.equal(
      workContext(work, s, b.id, new Date().toISOString()).retrieved_sources
        .length,
      0,
    );
    work.deliveries.push(
      s.send(chat.id, a.id, "Finding https://example.com/prior").id,
    );
    assert.deepEqual(
      completionProblems(
        s,
        null,
        { work: { [a.id]: work }, started_at: new Date().toISOString() },
        a.id,
      ),
      [],
    );
  } finally {
    s.db.close();
  }
});
