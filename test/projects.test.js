import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects } from "../src/projects.js";
test("projects start empty and isolate agent credentials, threads and state", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-projects-"));
  const projects = new Projects(dir);
  try {
    const a = projects.create("A", "First project"),
      b = projects.create("B", "Second project");
    const sa = projects.get(a.id).store,
      sb = projects.get(b.id).store;
    assert.equal(a.chats, 0);
    assert.equal(a.agents, 0);
    assert.equal(b.chats, 0);
    const agent = sa.createAgent("Writer", "Write");
    const chat = sa.createChat("Notes", "self", [agent.id]);
    sa.send(chat.id, agent.id, "Only A");
    assert.equal(sb.authenticate(agent.token), undefined);
    assert.equal(sb.chats().length, 0);
    assert.throws(() => sb.messages(chat.id), /not found/);
    assert.equal(projects.describe(a.id).messages, 1);
    assert.equal(projects.describe(b.id).messages, 0);
  } finally {
    projects.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("project history survives restart and interrupted runs can resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-projects-"));
  let projects = new Projects(dir);
  try {
    const p = projects.create("Persistent");
    const { store, harness } = projects.get(p.id);
    const a = store.createAgent("Writer", "Write");
    harness.completion = async () =>
      JSON.stringify({
        working_note: { name: "Planning", body: "Prepare a draft." },
        actions: [{ type: "finish" }],
      });
    harness.start([a.id], "Draft a proposal", 2);
    while (harness.run.status === "running")
      await new Promise((r) => setTimeout(r, 5));
    projects.close();
    projects = new Projects(dir);
    const reopened = projects.get(p.id);
    assert.equal(reopened.harness.run.task, "Draft a proposal");
    assert.equal(reopened.harness.run.status, "completed");
    assert.equal(reopened.harness.history.length, 1);
    assert.equal(reopened.store.chats().length, 1);
    reopened.store.saveRuntime({
      run: {
        id: "previous-run",
        status: "running",
        ids: [a.id],
        task: "Continue drafting",
        maxTurns: 2,
        turns: 1,
      },
      history: [],
    });
    projects.close();
    projects = new Projects(dir);
    const resumed = projects.get(p.id);
    assert.equal(resumed.harness.run.status, "interrupted");
    resumed.harness.completion = async () =>
      JSON.stringify({
        working_note: { name: "Planning", body: "Resume the existing draft." },
        actions: [{ type: "finish" }],
      });
    resumed.harness.start([a.id], resumed.harness.run.task, 2);
    while (resumed.harness.run.status === "running")
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(resumed.harness.run.status, "completed");
    assert.equal(resumed.store.chats().length, 1);
  } finally {
    projects.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
