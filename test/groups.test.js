import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { Workspace } from "../src/workspace.js";
import { Harness } from "../src/harness.js";
import { addReplyTarget, workFor } from "../src/work-contract.js";
test("group roles, evidence, ownership, lifecycle and history persist and enforce access", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-groups-"));
  let s = new Store(join(dir, "state.sqlite"));
  try {
    const owner = s.createAgent("Owner", "Lead"),
      member = s.createAgent("Member", "Contribute"),
      outsider = s.createAgent("Other", "Other");
    const w = new Workspace(s);
    const group = s.groups.ensure(
      "Review",
      "Resolve the research question",
      [owner.id, member.id],
      owner.id,
    );
    assert.throws(
      () => s.groups.decide(group.id, { decision_id: "invented" }, owner.id),
      (error) => error.validation === true,
    );
    assert.equal(
      s.groups.ensure(
        "Different label",
        "resolve the research question",
        [member.id, owner.id],
        owner.id,
      ).id,
      group.id,
    );
    assert.notEqual(
      s.groups.ensure(
        "Review",
        "A different question",
        [owner.id, member.id],
        owner.id,
      ).id,
      group.id,
    );
    assert.throws(
      () =>
        s.groups.update(
          group.id,
          { status: "blocked", blockers: ["No data"] },
          member.id,
          w,
        ),
      /owner/,
    );
    assert.throws(
      () => s.groups.decisions(group.id, outsider.id),
      /unavailable/,
    );
    assert.throws(
      () => s.groups.update(group.id, { owner_id: outsider.id }, owner.id, w),
      /member/,
    );
    s.groups.update(
      group.id,
      {
        roles: { [owner.id]: "Synthesize", [member.id]: "Verify evidence" },
        deliverables: ["report.md"],
        completion_criteria: "Report cites supporting evidence",
      },
      owner.id,
      w,
    );
    const privateChat = s.createChat("Private", "self", [member.id]);
    const privateMessage = s.send(
      privateChat.id,
      member.id,
      "PRIVATE_SENTINEL",
    );
    assert.throws(
      () =>
        s.groups.decide(
          group.id,
          {
            title: "Proposal",
            rationale: "Reason",
            evidence: [privateMessage.id],
          },
          member.id,
        ),
      /already be shared/,
    );
    const evidence = s.send(
      group.id,
      member.id,
      "Shared finding https://example.com/evidence",
    );
    const decision = s.groups.decide(
      group.id,
      {
        title: "Use the evidence",
        rationale:
          "It addresses the question; alternatives lack documentation.",
        evidence: [evidence.id],
      },
      member.id,
    );
    assert.equal(decision.status, "proposed");
    assert.throws(
      () =>
        s.groups.decide(
          group.id,
          { decision_id: decision.id, status: "accepted" },
          member.id,
        ),
      /owner/,
    );
    const report = s.send(group.id, owner.id, "Final synthesis: see report.md");
    assert.throws(
      () =>
        s.groups.update(
          group.id,
          { status: "resolved", final_message_id: report.id },
          owner.id,
          w,
        ),
      /pending decisions/,
    );
    s.groups.decide(
      group.id,
      { decision_id: decision.id, status: "accepted" },
      owner.id,
    );
    assert.throws(
      () =>
        s.groups.update(
          group.id,
          { status: "resolved", final_message_id: report.id },
          owner.id,
          w,
        ),
      /Missing group deliverable/,
    );
    w.write("report.md", "Report with sources", 0, owner.id);
    s.groups.update(
      group.id,
      { status: "resolved", final_message_id: report.id },
      owner.id,
      w,
    );
    assert.equal(s.chat(group.id).group.status, "resolved");
    assert.throws(
      () =>
        s.groups.decide(
          group.id,
          { decision_id: decision.id, status: "proposed" },
          owner.id,
        ),
      /Reopen/,
    );
    s.groups.update(group.id, { status: "active" }, owner.id, w);
    assert.throws(
      () => s.groups.update(group.id, { status: "blocked" }, owner.id, w),
      /blockers/,
    );
    s.groups.update(
      group.id,
      { status: "blocked", blockers: ["Awaiting additional evidence"] },
      owner.id,
      w,
    );
    const events = s.groups.history(group.id, owner.id).results;
    assert.ok(
      events.some(
        (e) =>
          e.data.before?.status === "proposed" &&
          e.data.after?.status === "accepted",
      ),
    );
    assert.ok(
      !JSON.stringify(s.messages(group.id)).includes("PRIVATE_SENTINEL"),
    );
    s.db.close();
    s = new Store(join(dir, "state.sqlite"));
    assert.equal(s.chat(group.id).group.status, "blocked");
    assert.equal(
      s.groups.decisions(group.id, owner.id).results[0].rationale,
      "It addresses the question; alternatives lack documentation.",
    );
    assert.equal(
      s.groups.history(group.id, owner.id).results.length,
      events.length,
    );
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("teams create their shared workspace on demand and owner cannot finish without a final report", async () => {
  const s = new Store();
  try {
    const agents = [
      s.createAgent("Lead", "Lead"),
      s.createAgent("Analyst", "Analyze"),
      s.createAgent("Reviewer", "Review"),
    ];
    const privateChat = s.createChat("Private", "self", [agents[0].id]);
    s.send(privateChat.id, agents[0].id, "PRIVATE_SENTINEL");
    assert.equal(s.chats().filter((c) => c.kind === "group").length, 0);
    const calls = new Map();
    const h = new Harness(
      s,
      () => {},
      async (messages) => {
        const ctx = JSON.parse(messages[1].content),
          actor = ctx.you.id;
        const call = (calls.get(actor) || 0) + 1;
        calls.set(actor, call);
        const chatId = ctx.work_contract.shared_group_id;
        let actions;
        if (actor !== agents[0].id)
          actions =
            call === 1
              ? [
                  {
                    type: "send",
                    chat_id: chatId,
                    body: "Reviewed findings; no unresolved disagreement.",
                  },
                  { type: "finish", summary: "Review delivered." },
                ]
              : [{ type: "finish", summary: "Nothing else pending." }];
        else if (call === 1)
          actions = [
            { type: "finish", summary: "Premature completion must fail." },
          ];
        else if (call === 2)
          actions = [
            {
              type: "reply",
              body: "Final team synthesis with stated limitations.",
            },
          ];
        else {
          const reportId = workFor(h.run, actor).deliveries.at(-1);
          actions = [
            {
              type: "update_group",
              chat_id: chatId,
              status: "resolved",
              final_message_id: reportId,
            },
            {
              type: "finish",
              summary: "Final synthesis published; no pending decisions.",
            },
          ];
        }
        return JSON.stringify({
          working_note: { name: "Work", body: "Coordinate task." },
          actions,
        });
      },
    );
    h.start(
      agents.map((a) => a.id),
      "Shared work",
      12,
    );
    while (h.run.status === "running")
      await new Promise((r) => setTimeout(r, 2));
    assert.equal(h.run.completion.status, "checks_passed");
    assert.ok(
      h.history.some((e) => e.message?.includes("Publish the final report")),
    );
    const group = s.chat(h.run.shared_group_id);
    assert.equal(group.group.status, "resolved");
    assert.ok(group.group.final_message_id);
    assert.ok(
      !s.messages(group.id).some((m) => m.body.includes("PRIVATE_SENTINEL")),
    );
  } finally {
    s.db.close();
  }
});
test("private request routing stays private and group discovery does not copy private content", () => {
  const s = new Store();
  try {
    const agents = [
      s.createAgent("A", "Work"),
      s.createAgent("B", "Work"),
      s.createAgent("C", "Work"),
    ];
    const privateChat = s.createChat("Private", "self", [agents[0].id]);
    const request = s.send(privateChat.id, null, "CONFIDENTIAL TASK");
    const h = new Harness(s),
      run = { ids: agents.map((a) => a.id) };
    addReplyTarget(run, agents[0].id, request);
    const group = h.ensureTeamGroup(run);
    assert.equal(workFor(run, agents[0].id).synthesis_group_id, undefined);
    assert.equal(
      workFor(run, agents[0].id).reply_targets[0].chat_id,
      privateChat.id,
    );
    assert.equal(s.messages(group.id).length, 0);
    assert.ok(!JSON.stringify(group).includes("CONFIDENTIAL TASK"));
  } finally {
    s.db.close();
  }
});

test("decision evidence schema and validation reject ambiguous object references", async () => {
  const { validateAction, actionStructuredFields } =
    await import("../src/action-validation.js");
  assert.throws(
    () =>
      validateAction({
        type: "record_decision",
        chat_id: "group",
        evidence: [{ message_id: 42 }],
      }),
    /integer message IDs/,
  );
  assert.doesNotThrow(() =>
    validateAction({
      type: "record_decision",
      chat_id: "group",
      evidence: [42, "https:\/\/example.com/source"],
    }),
  );
  assert.equal(
    actionStructuredFields.record_decision.evidence.items.anyOf[0].type,
    "integer",
  );
});

for (const workflow of ["direct acceptance", "proposal then acceptance"]) {
  test("model-independent decision workflow: " + workflow, () => {
    const s = new Store();
    try {
      const owner = s.createAgent("Owner", "Coordinate");
      const member = s.createAgent("Reviewer", "Review");
      const group = s.groups.ensure(
        "Review",
        "Choose an approach",
        [owner.id, member.id],
        owner.id,
      );
      const evidence = s.send(
        group.id,
        member.id,
        "Reviewed both alternatives.",
      );
      let decision = s.groups.decide(
        group.id,
        {
          title: "Choose approach A",
          rationale: "Meets the stated requirements",
          evidence: [evidence.id],
          status: workflow === "direct acceptance" ? "accepted" : "proposed",
        },
        workflow === "direct acceptance" ? owner.id : member.id,
      );
      if (decision.status === "proposed")
        decision = s.groups.decide(
          group.id,
          { decision_id: decision.id, status: "accepted" },
          owner.id,
        );
      assert.equal(decision.status, "accepted");
      assert.deepEqual(decision.evidence, [evidence.id]);
      const schema = new Harness(s)
        .responseSchema()
        .properties.actions.items.anyOf.find(
          (branch) => branch.properties.type.enum[0] === "record_decision",
        );
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.anyOf, [
        { required: ["decision_id"] },
        { required: ["title", "rationale"] },
      ]);
    } finally {
      s.db.close();
    }
  });
}

test("resuming retains group identity after purpose changes, including after restart", () => {
  const s = new Store();
  try {
    const ids = ["Lead", "Analyst", "Reviewer"].map(
      (name) => s.createAgent(name, "Work").id,
    );
    const h = new Harness(
      s,
      () => {},
      async () => {},
    );
    h.loop = () => {};
    h.start(ids, "Research", 10);
    const group = h.ensureTeamGroup(h.run);
    s.groups.update(
      group.id,
      {
        purpose: "Refined research scope",
        status: "blocked",
        blockers: ["Need evidence"],
      },
      ids[0],
    );
    h.stop();
    const resumed = new Harness(
      s,
      () => {},
      async () => {},
    );
    resumed.loop = () => {};
    resumed.start(ids, "Continue research", 10);
    const reused = resumed.ensureTeamGroup(resumed.run);
    assert.equal(reused.id, group.id);
    assert.equal(reused.group.purpose, "Refined research scope");
    assert.equal(reused.group.status, "blocked");
    assert.deepEqual(reused.group.blockers, ["Need evidence"]);
    assert.equal(s.chats().filter((c) => c.kind === "group").length, 1);
    resumed.stop();

    // A request explicitly addressed to another group takes precedence.
    const other = s.createChat(
      "Other discussion",
      "group",
      ids,
      ids[0],
      "Other purpose",
    );
    resumed.start(ids, "Respond to the other group", 10);
    addReplyTarget(resumed.run, ids[0], s.send(other.id, null, "Review here"));
    assert.equal(resumed.ensureTeamGroup(resumed.run).id, other.id);
    resumed.stop();

    // A changed team must not gain automatic access to the previous group's history.
    const newcomer = s.createAgent("New reviewer", "Review").id;
    resumed.start([ids[0], ids[1], newcomer], "New team", 10);
    assert.notEqual(resumed.ensureTeamGroup(resumed.run).id, other.id);
    assert.ok(!s.chat(other.id).members.includes(newcomer));
    resumed.stop();
  } finally {
    s.db.close();
  }
});
