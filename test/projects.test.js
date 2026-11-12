import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Projects } from "../src/projects.js";
import { weatherPlugin } from "../public/plugins.js";

test("setup duplication copies agent and tool configuration into an empty independent project", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-copy-setup-"));
  const projects = new Projects(dir);
  try {
    const original = projects.create("Source", "Objective");
    const source = projects.get(original.id);
    source.store.savePlugin(
      { ...weatherPlugin, auth: { type: "bearer" } },
      "fixture-secret",
    );
    const a = source.store.createAgent("Researcher", "Search carefully", [
      weatherPlugin.name,
    ]);
    source.harness.configure({ allow_agent_creation: true, max_new_agents: 5 });
    const connection = projects.models.save({
      label: "Shared connection",
      name: "model",
      api_base: "https://example.com/v1",
      api_key_env: "",
    });
    source.harness.selectModel(connection.id);
    source.workspace.configureEnvironment({
      use_uv: true,
      allow_package_install: true,
    });
    const chat = source.store.createChat("Notes", "self", [a.id]);
    source.store.send(chat.id, a.id, "Do not copy in setup mode");
    source.workspace.write("source.txt", "Source file", 0, a.id);
    const copy = projects.duplicate(original.id, {
      name: "Setup copy",
      mode: "setup",
    });
    const target = projects.get(copy.id);
    assert.equal(copy.summary, original.summary);
    assert.equal(copy.agents, 2);
    assert.equal(copy.chats, 0);
    assert.equal(copy.messages, 0);
    assert.equal(copy.run, null);
    assert.equal(target.workspace.list().length, 0);
    assert.equal(target.workspace.history().length, 0);
    assert.equal(target.harness.settings.max_new_agents, 5);
    assert.equal(target.harness.modelId, connection.id);
    assert.equal(target.harness.selectedModel().name, "model");
    assert.deepEqual(
      target.workspace.environment(),
      source.workspace.environment(),
    );
    const copiedAgent = target.store
      .agents()
      .find((agent) => agent.name === a.name);
    assert.notEqual(copiedAgent.id, a.id);
    assert.equal(copiedAgent.prompt, a.prompt);
    assert.deepEqual(copiedAgent.tools, a.tools);
    assert.equal(target.store.authenticate(a.token), undefined);
    assert.equal(
      target.store.get("SELECT credential FROM plugins").credential,
      "fixture-secret",
    );
    target.store.removePlugin(weatherPlugin.name);
    assert.equal(source.store.plugins().length, 1);
    assert.ok(existsSync(join(original.workspace_path, "source.txt")));
    assert.deepEqual(target.harness.requests, []);
  } finally {
    projects.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full duplication preserves WAL content, artifacts, Git history and files without sharing storage or tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-copy-full-"));
  let projects = new Projects(dir);
  try {
    const original = projects.create("Source");
    const source = projects.get(original.id);
    const a = source.store.createAgent("Writer", "Write");
    const chat = source.store.createChat("Notes", "self", [a.id]);
    const message = source.store.send(chat.id, a.id, "Original evidence");
    const artifact = source.store.artifacts.save(
      "complete 😀 output".repeat(10000),
      { owner: a.id, chat_id: chat.id },
    );
    source.workspace.write("nested/a.txt", "one", 0, a.id);
    source.workspace.write("nested/a.txt", "two", 1, a.id);
    source.workspace.mkdir("empty");
    mkdirSync(join(original.workspace_path, ".venv"));
    writeFileSync(
      join(original.workspace_path, ".venv", "marker"),
      "environment",
    );
    writeFileSync(
      join(original.workspace_path, "binary.bin"),
      Buffer.from([0, 255, 1]),
    );
    source.harness.run = {
      id: "saved-run",
      status: "completed",
      task: "Write",
      ids: [a.id],
      turns: 2,
      maxTurns: 4,
    };
    source.harness.requests = [
      { id: "old-request", status: "delivered", remaining: [] },
    ];
    source.harness.notify();
    const copy = projects.duplicate(original.id, {
      name: "Full copy",
      mode: "full",
    });
    const target = projects.get(copy.id);
    assert.equal(target.store.messages(chat.id)[0].id, message.id);
    assert.equal(target.store.messages(chat.id)[0].body, "Original evidence");
    assert.equal(
      [...target.store.artifacts.chunks(artifact, a.id)].join(""),
      "complete 😀 output".repeat(10000),
    );
    assert.equal(target.store.authenticate(a.token), undefined);
    assert.equal(source.store.authenticate(a.token), a.id);
    assert.ok(target.store.agents().every((agent) => agent.status === "idle"));
    assert.equal(target.harness.run.status, "stopped");
    assert.equal(target.harness.run.task, "Write");
    assert.ok(!target.harness.requests.some((r) => r.status === "queued"));
    assert.equal(target.workspace.read("nested/a.txt", 1).content, "one");
    assert.equal(
      target.workspace.folder.git(["rev-parse", "HEAD"]),
      source.workspace.folder.git(["rev-parse", "HEAD"]),
    );
    assert.equal(
      target.workspace.folder.git(["config", "core.worktree"]),
      copy.workspace_path,
    );
    assert.ok(
      readFileSync(join(copy.workspace_path, ".git"), "utf8").includes(copy.id),
    );
    assert.ok(existsSync(join(copy.workspace_path, "empty")));
    assert.equal(
      readFileSync(join(copy.workspace_path, ".venv", "marker"), "utf8"),
      "environment",
    );
    assert.deepEqual(
      readFileSync(join(copy.workspace_path, "binary.bin")),
      Buffer.from([0, 255, 1]),
    );
    target.workspace.write("nested/a.txt", "copy only", 2, a.id);
    target.store.send(chat.id, a.id, "Only the copy");
    assert.equal(source.workspace.read("nested/a.txt").content, "two");
    assert.equal(source.store.messages(chat.id).length, 1);
    projects.delete(original.id, {
      confirm_name: original.name,
      delete_artifacts: true,
    });
    projects.close();
    projects = new Projects(dir);
    const reopened = projects.get(copy.id);
    assert.equal(reopened.workspace.read("nested/a.txt", 1).content, "one");
    assert.equal(
      reopened.workspace.folder.git(["show", "HEAD:nested/a.txt"]),
      "copy only",
    );
    assert.equal(reopened.store.artifacts.info(artifact, a.id).complete, 1);
    assert.equal(reopened.harness.run.status, "stopped");
  } finally {
    projects.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplication rejects invalid choices and active full copies without creating partial projects", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-copy-active-"));
  const projects = new Projects(dir);
  try {
    const original = projects.create("Source");
    const source = projects.get(original.id);
    assert.throws(
      () => projects.duplicate(original.id, { name: "Copy", mode: "invalid" }),
      /Choose/,
    );
    assert.throws(
      () => projects.duplicate(original.id, { name: " ", mode: "full" }),
      /name/,
    );
    source.workspace.locked = true;
    assert.throws(
      () => projects.duplicate(original.id, { name: "Copy", mode: "full" }),
      /Stop the source/,
    );
    source.workspace.locked = false;
    source.harness.requests = [{ status: "queued", remaining: [] }];
    assert.throws(
      () => projects.duplicate(original.id, { name: "Copy", mode: "full" }),
      /queued requests/,
    );
    source.harness.requests = [];
    assert.equal(projects.list().length, 1);
  } finally {
    projects.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
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
