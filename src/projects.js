import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  copyFileSync,
  readdirSync,
  existsSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join, resolve, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, AppError } from "./store.js";
import { safeDirectory } from "./project-folder.js";
import { Workspace } from "./workspace.js";
import { PythonSandbox } from "./sandbox.js";
import { Harness } from "./harness.js";

export function defaultAgentPrompt(name, summary = "") {
  const title = String(name || "Project").trim();
  const details = String(summary || "").trim();
  return details
    ? `You are the lead agent for "${title}". Project objective and context: ${details}\n\nThink carefully in private working notes, recruit or collaborate with teammates using direct messages for 1-on-1 tasks and questions (and group chats only when 3+ agents need shared alignment), maintain clear chat summaries, and deliver well-verified results.`
    : `You are the lead agent for "${title}". Think carefully in private working notes, recruit or collaborate with teammates using direct messages for 1-on-1 tasks and questions (and group chats only when 3+ agents need shared alignment), maintain clear chat summaries, and deliver well-verified results.`;
}

export class Projects {
  constructor(directory = "data/projects", notify = () => {}) {
    this.directory = safeDirectory(directory);
    this.notify = notify;
    this.open = new Map();
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "catalog.sqlite"));
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL)",
    );
    if (
      !this.db
        .prepare("PRAGMA table_info(projects)")
        .all()
        .some((c) => c.name === "workspace_path")
    )
      this.db.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
  }
  create(name, summary = "", source = null, workspacePath = "") {
    if (typeof name !== "string" || !name.trim() || typeof summary !== "string")
      throw new AppError("Project name is required");
    const id = randomUUID();
    let root = resolve(this.directory, "workspaces", id);
    if (workspacePath) {
      if (typeof workspacePath !== "string" || !isAbsolute(workspacePath))
        throw new AppError("Choose an absolute path for the project folder");
      root = safeDirectory(workspacePath);
      if (/[\r\n,]/.test(root))
        throw new AppError("Workspace paths cannot contain commas or newlines");
      const overlaps = (a, b) =>
        a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
      if (overlaps(root, this.directory))
        throw new AppError(
          "Choose a project folder outside Relay's data directory",
        );
      for (const p of this.db
        .prepare("SELECT id,workspace_path FROM projects")
        .all())
        if (
          overlaps(
            root,
            p.workspace_path || resolve(this.directory, "workspaces", p.id),
          )
        )
          throw new AppError("Project workspace folders cannot overlap");
    }
    root = safeDirectory(root);
    if (readdirSync(root).length)
      throw new AppError(
        "Choose a new or empty folder; existing files will not be overwritten",
      );
    if (source) copyFileSync(source, join(this.directory, id + ".sqlite"));
    this.db
      .prepare(
        "INSERT INTO projects(id,name,summary,created_at,workspace_path) VALUES(?,?,?,?,?)",
      )
      .run(id, name.trim(), summary, new Date().toISOString(), root);
    if (!source) {
      const { store } = this.get(id);
      if (!store.agents().length)
        store.createAgent("Lead", defaultAgentPrompt(name.trim(), summary));
    }
    return this.describe(id);
  }
  get(id) {
    const project = this.db
      .prepare("SELECT * FROM projects WHERE id=?")
      .get(id);
    if (!project) throw new AppError("Project not found", 404);
    if (!this.open.has(id)) {
      const store = new Store(join(this.directory, id + ".sqlite"));
      const root =
        project.workspace_path || resolve(this.directory, "workspaces", id);
      if (
        !existsSync(root) &&
        store.get(
          "SELECT name FROM sqlite_master WHERE name='workspace_meta'",
        ) &&
        store.get(
          "SELECT value FROM workspace_meta WHERE key='filesystem_migrated'",
        )
      )
        throw new AppError("Project folder is missing: " + root);
      const workspace = new Workspace(store, {
        root,
        gitDir: resolve(this.directory, "git", id + ".git"),
      });
      project.workspace_path = workspace.root;
      this.db
        .prepare("UPDATE projects SET workspace_path=? WHERE id=?")
        .run(workspace.root, id);
      const sandbox = new PythonSandbox(workspace, () => this.notify(id));
      const harness = new Harness(store, () => this.notify(id), null, {
        workspace,
        sandbox,
      });
      this.open.set(id, { project, store, harness, workspace, sandbox });
      if (harness.requests.some((r) => r.status === "queued"))
        harness.scheduleRequests();
    }
    return this.open.get(id);
  }
  delete(id, { confirm_name, delete_artifacts = false } = {}) {
    const project = this.db
      .prepare("SELECT * FROM projects WHERE id=?")
      .get(id);
    if (!project) throw new AppError("Project not found", 404);
    if (confirm_name !== project.name || typeof delete_artifacts !== "boolean")
      throw new AppError("Type the exact project name to confirm deletion");
    const opened = this.open.get(id);
    if (
      opened &&
      (opened.harness.run?.status === "running" ||
        (opened.harness.run?.controller && !opened.harness.run.ended_at) ||
        opened.sandbox.busy ||
        opened.workspace.locked)
    )
      throw new AppError(
        "Stop the project and wait for its executions to finish before deleting it",
        409,
      );
    const artifacts = [
      project.workspace_path || resolve(this.directory, "workspaces", id),
      resolve(this.directory, "git", id + ".git"),
      resolve(this.directory, "uv-cache", id),
    ];
    if (delete_artifacts) {
      // Validate every ancestor before recursively removing user-selected folders.
      // Child symlinks are unlinked by rmSync, never followed.
      for (const artifact of artifacts) {
        let current = resolve(artifact);
        while (current !== resolve(current, "..")) {
          try {
            if (lstatSync(current).isSymbolicLink())
              throw new AppError(
                "Refusing to delete artifacts through a symlink: " + current,
              );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          current = resolve(current, "..");
        }
      }
      for (const artifact of artifacts)
        rmSync(artifact, { recursive: true, force: true });
    }
    if (opened) {
      opened.harness.stop();
      opened.store.db.close();
      this.open.delete(id);
    }
    for (const suffix of [".sqlite", ".sqlite-wal", ".sqlite-shm"])
      rmSync(join(this.directory, id + suffix), { force: true });
    this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
    this.notify();
    return {
      ok: true,
      deleted_artifacts: delete_artifacts,
      retained_paths: delete_artifacts ? [] : artifacts,
    };
  }
  describe(id) {
    const { project, store, harness } = this.get(id);
    const run = harness.state().run;
    return {
      ...project,
      agents: store.agents().length,
      chats: store.chats().length,
      messages: store.get("SELECT COUNT(*) AS n FROM messages").n,
      run,
      updated_at:
        run?.ended_at ||
        run?.started_at ||
        store.get("SELECT MAX(created_at) AS at FROM messages").at ||
        project.created_at,
    };
  }
  list() {
    return this.db
      .prepare("SELECT id FROM projects ORDER BY created_at DESC")
      .all()
      .map((p) => this.describe(p.id));
  }
  sync() {
    for (const { workspace, project } of this.open.values()) {
      try {
        if (workspace.sync()) this.notify(project.id);
      } catch (e) {
        if (workspace.warnings[0] !== e.message) {
          workspace.warnings = [e.message];
          this.notify(project.id);
        }
      }
    }
  }
  close() {
    for (const { store, harness } of this.open.values()) {
      harness.stop();
      store.db.close();
    }
    this.db.close();
  }
}
