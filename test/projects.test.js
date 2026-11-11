import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects } from "../src/projects.js";
test("projects start with an editable default lead agent and isolate credentials, threads and state", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-projects-"));
  const projects = new Projects(dir);
  try {
    const a = projects.create("A", "First project"),
      b = projects.create("B", "Second project");
    const sa = projects.get(a.id).store,
      sb = projects.get(b.id).store;
    assert.equal(a.chats, 0);
    assert.equal(a.agents, 1);
    assert.equal(b.agents, 1);
    assert.equal(sa.agents()[0].name, "Lead");
    assert.match(sa.agents()[0].prompt, /First project/);
    assert.match(sb.agents()[0].prompt, /Second project/);
    const updated = sa.updateAgent(sa.agents()[0].id, {
      name: "Coordinator",
      prompt: "Custom coordinator prompt",
    });
    assert.equal(updated.name, "Coordinator");
    assert.equal(updated.prompt, "Custom coordinator prompt");
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

test("project deletion requires confirmation and optionally preserves artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-delete-"));
  const projects = new Projects(join(dir, "catalog"));
  try {
    const p = projects.create("Keep files"),
      other = projects.create("Other");
    projects.get(p.id).workspace.write("main.py", "print(1)\n", 0);
    assert.throws(
      () =>
        projects.delete(p.id, {
          confirm_name: "wrong",
          delete_artifacts: true,
        }),
      /exact project name/,
    );
    assert.ok(existsSync(join(p.workspace_path, "main.py")));
    const result = projects.delete(p.id, { confirm_name: p.name });
    assert.equal(result.deleted_artifacts, false);
    assert.ok(existsSync(join(p.workspace_path, "main.py")));
    assert.ok(existsSync(join(projects.directory, "git", p.id + ".git")));
    assert.equal(existsSync(join(projects.directory, p.id + ".sqlite")), false);
    assert.throws(() => projects.get(p.id), /not found/);
    assert.equal(projects.list()[0].id, other.id);
  } finally {
    projects.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full project deletion removes custom workspace, uv artifacts, Git and SQLite only for that project", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-delete-all-"));
  const projects = new Projects(join(dir, "catalog"));
  try {
    const p = projects.create("Remove files", "", null, join(dir, "custom"));
    const other = projects.create("Other");
    const runtime = projects.get(p.id);
    runtime.workspace.write("main.py", "print(1)\n", 0);
    mkdirSync(join(p.workspace_path, ".venv"));
    writeFileSync(join(p.workspace_path, ".venv", "marker"), "env");
    const cache = join(projects.directory, "uv-cache", p.id);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "marker"), "cache");
    const outside = join(dir, "keep.txt");
    writeFileSync(outside, "keep");
    symlinkSync(outside, join(p.workspace_path, "outside-link"));
    runtime.workspace.locked = true;
    assert.throws(
      () =>
        projects.delete(p.id, { confirm_name: p.name, delete_artifacts: true }),
      /Stop the project/,
    );
    runtime.workspace.locked = false;
    projects.delete(p.id, { confirm_name: p.name, delete_artifacts: true });
    for (const path of [
      p.workspace_path,
      cache,
      join(projects.directory, "git", p.id + ".git"),
      join(projects.directory, p.id + ".sqlite"),
    ])
      assert.equal(existsSync(path), false);
    assert.ok(existsSync(outside));
    assert.ok(existsSync(other.workspace_path));
    assert.equal(projects.open.has(p.id), false);
    projects.sync();
  } finally {
    projects.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full deletion refuses replaced workspace symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-delete-link-"));
  const projects = new Projects(join(dir, "catalog"));
  try {
    const p = projects.create("Protected");
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "keep");
    rmSync(p.workspace_path, { recursive: true });
    symlinkSync(outside, p.workspace_path);
    assert.throws(
      () =>
        projects.delete(p.id, { confirm_name: p.name, delete_artifacts: true }),
      /symlink/,
    );
    assert.ok(existsSync(join(outside, "keep")));
    assert.ok(projects.open.has(p.id));
  } finally {
    projects.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
