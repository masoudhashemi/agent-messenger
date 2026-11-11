import { AppError } from "./store.js";
import { excludedWorkspacePath } from "./workspace-exclusions.js";
import { ProjectFolder } from "./project-folder.js";
export class Workspace {
  constructor(store, options = null) {
    this.locked = false;
    this.syncing = false;
    this.warnings = [];
    this.unsupported = [];
    this.store = store;
    store.db.exec(`
 CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,content TEXT NOT NULL,revision INTEGER NOT NULL,updated_by TEXT,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS file_versions(path TEXT,revision INTEGER,content TEXT NOT NULL,updated_by TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(path,revision));
 CREATE TABLE IF NOT EXISTS directories(path TEXT PRIMARY KEY,created_by TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workspace_artifacts(path TEXT PRIMARY KEY,hash TEXT,bytes INTEGER);
 CREATE TABLE IF NOT EXISTS file_version_info(path TEXT,revision INTEGER,git_commit TEXT,source TEXT,kind TEXT,execution_id TEXT,PRIMARY KEY(path,revision));
 CREATE TABLE IF NOT EXISTS workspace_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,git_commit TEXT,actor TEXT,source TEXT,execution_id TEXT,created_at TEXT,changes TEXT);
 CREATE TABLE IF NOT EXISTS workspace_meta(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY,record TEXT NOT NULL);
 `);
    if (options) {
      this.folder = new ProjectFolder(options.root, options.gitDir);
      this.root = this.folder.root;
      this.migrate();
      this.sync();
    }
  }
  author(actor, source) {
    return actor
      ? this.store.agent(actor)
      : { name: source === "external" ? "External editor" : "Operator" };
  }
  event(
    commit,
    actor,
    source,
    changes,
    execution_id = null,
    at = new Date().toISOString(),
  ) {
    this.store.run(
      "INSERT INTO workspace_changes(git_commit,actor,source,execution_id,created_at,changes) VALUES(?,?,?,?,?,?)",
      commit,
      actor,
      source,
      execution_id,
      at,
      JSON.stringify(changes),
    );
  }
  migrate() {
    if (
      this.store.get(
        "SELECT value FROM workspace_meta WHERE key='filesystem_migrated'",
      )
    )
      return;
    const versions = this.store.all(
      "SELECT * FROM file_versions ORDER BY updated_at,rowid",
    );
    for (const version of versions) {
      if (excludedWorkspacePath(version.path)) continue;
      this.path(version.path);
      this.folder.write(version.path, version.content);
      if (
        this.store.get(
          "SELECT 1 FROM file_version_info WHERE path=? AND revision=?",
          version.path,
          version.revision,
        )
      )
        continue;
      const hash = this.folder.commit(
        [version.path],
        `Import ${version.path} · revision ${version.revision}`,
        this.author(version.updated_by, "migration"),
        version.updated_at,
      );
      this.store.run(
        "INSERT INTO file_version_info VALUES(?,?,?,?,?,?)",
        version.path,
        version.revision,
        hash,
        "migration",
        version.revision === 1 ? "created" : "modified",
        null,
      );
      this.event(
        hash,
        version.updated_by,
        "migration",
        [
          {
            path: version.path,
            kind: version.revision === 1 ? "created" : "modified",
            revision: version.revision,
          },
        ],
        null,
        version.updated_at,
      );
    }
    for (const d of this.store.all("SELECT path FROM directories")) {
      if (excludedWorkspacePath(d.path)) continue;
      this.path(d.path);
      this.folder.mkdir(d.path);
    }
    this.store.run(
      "INSERT INTO workspace_meta VALUES('filesystem_migrated','1')",
    );
  }
  ensureWritable() {
    if (this.locked)
      throw new AppError(
        "Workspace is busy running Python. Retry after execution finishes.",
        409,
      );
    this.sync();
  }
  sync(actor = null, source = "external", execution_id = null) {
    if (!this.folder || this.locked || this.syncing) return false;
    this.syncing = true;
    try {
      const scan = this.folder.scan();
      const warningChanged =
        JSON.stringify(this.warnings) !== JSON.stringify(scan.warnings);
      this.warnings = scan.warnings;
      this.unsupported = scan.unsupported;
      const old = this.store.all("SELECT * FROM files"),
        existing = new Map(old.map((f) => [f.path, f]));
      const current = new Map(scan.files.map((f) => [f.path, f]));
      const changes = [];
      for (const f of scan.files)
        if (existing.get(f.path)?.content !== f.content)
          changes.push({
            ...f,
            kind: existing.has(f.path) ? "modified" : "created",
          });
      for (const f of old)
        if (!current.has(f.path))
          changes.push({ path: f.path, content: "", kind: "deleted" });
      const oldArtifacts = this.store.all("SELECT * FROM workspace_artifacts");
      const artifactChanges = scan.artifacts
        .filter(
          (f) => oldArtifacts.find((x) => x.path === f.path)?.hash !== f.hash,
        )
        .map((f) => ({
          ...f,
          kind: oldArtifacts.some((x) => x.path === f.path)
            ? "modified"
            : "created",
          artifact: true,
        }));
      for (const f of oldArtifacts)
        if (
          !scan.artifacts.some((x) => x.path === f.path) &&
          !current.has(f.path) &&
          !scan.unsupported.some((x) => x.path === f.path)
        )
          artifactChanges.push({
            path: f.path,
            kind: "deleted",
            artifact: true,
          });
      const dirs = this.store
        .all("SELECT path FROM directories")
        .map((d) => d.path);
      const directoryChanges = [
        ...scan.directories
          .filter((d) => !dirs.includes(d))
          .map((path) => ({ path, kind: "folder_created" })),
        ...dirs
          .filter((d) => !scan.directories.includes(d))
          .map((path) => ({ path, kind: "folder_deleted" })),
      ];
      if (
        !changes.length &&
        !directoryChanges.length &&
        !artifactChanges.length
      )
        return warningChanged;
      const paths = changes
        .map((c) => c.path)
        .filter(
          (path) =>
            !scan.unsupported.some((f) => f.path === path) &&
            !scan.warnings.some((w) => w.endsWith(": " + path)),
        );
      const hash = this.folder.commit(
        [...new Set([...paths, ...artifactChanges.map((c) => c.path)])],
        `${source}: ${changes.length + artifactChanges.length} file changes, ${directoryChanges.length} folder changes`,
        this.author(actor, source),
      );
      const at = new Date().toISOString();
      this.store.db.exec("BEGIN");
      try {
        for (const c of changes) {
          const revision =
            (this.store.get(
              "SELECT MAX(revision) AS n FROM file_versions WHERE path=?",
              c.path,
            )?.n || 0) + 1;
          c.revision = revision;
          if (c.kind === "deleted")
            this.store.run("DELETE FROM files WHERE path=?", c.path);
          else
            this.store.run(
              "INSERT INTO files VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
              c.path,
              c.content,
              revision,
              actor,
              at,
            );
          this.store.run(
            "INSERT INTO file_versions VALUES(?,?,?,?,?)",
            c.path,
            revision,
            c.content,
            actor,
            at,
          );
          this.store.run(
            "INSERT INTO file_version_info VALUES(?,?,?,?,?,?)",
            c.path,
            revision,
            hash,
            source,
            c.kind,
            execution_id,
          );
        }
        this.store.run("DELETE FROM workspace_artifacts");
        for (const f of scan.artifacts)
          this.store.run(
            "INSERT INTO workspace_artifacts VALUES(?,?,?)",
            f.path,
            f.hash,
            f.bytes,
          );
        for (const d of directoryChanges) {
          if (d.kind === "folder_deleted")
            this.store.run("DELETE FROM directories WHERE path=?", d.path);
          else
            this.store.run(
              "INSERT OR IGNORE INTO directories VALUES(?,?,?)",
              d.path,
              actor,
              at,
            );
        }
        this.event(
          hash,
          actor,
          source,
          [
            ...changes.map(({ content, ...c }) => c),
            ...artifactChanges,
            ...directoryChanges,
          ],
          execution_id,
          at,
        );
        this.store.db.exec("COMMIT");
      } catch (e) {
        this.store.db.exec("ROLLBACK");
        throw e;
      }
      return true;
    } finally {
      this.syncing = false;
    }
  }
  history() {
    return this.store
      .all("SELECT * FROM workspace_changes ORDER BY id DESC LIMIT 100")
      .map((e) => ({ ...e, changes: JSON.parse(e.changes) }));
  }
  info() {
    return {
      root: this.root || null,
      environment: this.environment(),
      git_dir: this.folder?.gitDir || null,
      busy: this.locked,
      warnings: this.warnings,
      unsupported: this.unsupported,
      history: this.history(),
    };
  }

  environment() {
    const row = this.store.get(
      "SELECT value FROM workspace_meta WHERE key='environment'",
    );
    return row
      ? JSON.parse(row.value)
      : { use_uv: false, allow_package_install: false };
  }
  configureEnvironment(settings) {
    if (this.locked)
      throw new AppError(
        "Wait for the current execution to finish before changing its environment",
        409,
      );
    if (
      typeof settings.use_uv !== "boolean" ||
      typeof settings.allow_package_install !== "boolean"
    )
      throw new AppError("Environment settings must be booleans");
    if (settings.use_uv && !this.root)
      throw new AppError("uv requires a persistent project folder");
    const value = {
      use_uv: settings.use_uv,
      allow_package_install: settings.allow_package_install,
    };
    this.store.run(
      "INSERT INTO workspace_meta VALUES('environment',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(value),
    );
    return value;
  }
  path(path) {
    if (
      typeof path !== "string" ||
      path.length > 240 ||
      excludedWorkspacePath(path) ||
      !path ||
      path
        .split("/")
        .some(
          (p) =>
            !p ||
            p === "." ||
            p === ".." ||
            p === ".git" ||
            p.startsWith(".relay-write-") ||
            !/^[a-zA-Z0-9_.-]+$/.test(p),
        )
    )
      throw new AppError(
        "Use a relative project path with no traversal, spaces or special characters",
      );
    return path;
  }
  directories() {
    this.sync();
    const dirs = new Map(
      this.store
        .all("SELECT * FROM directories ORDER BY path")
        .map((d) => [d.path, d]),
    );
    for (const file of this.list()) {
      const parts = file.path.split("/");
      parts.pop();
      while (parts.length) {
        const path = parts.join("/");
        if (!dirs.has(path))
          dirs.set(path, { path, created_by: null, created_at: null });
        parts.pop();
      }
    }
    return [...dirs.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  mkdir(path, actor = null) {
    this.ensureWritable();
    this.path(path);
    if (actor) this.store.agent(actor);
    const parts = path.split("/"),
      paths = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    if (
      paths.some((p) => this.store.get("SELECT 1 FROM files WHERE path=?", p))
    )
      throw new AppError("A file conflicts with this directory path");
    const existing = this.directories();
    if (new Set([...existing.map((d) => d.path), ...paths]).size > 500)
      throw new AppError("Project limit: 500 directories");
    if (this.folder) {
      this.folder.mkdir(path);
      this.sync(actor, "mkdir");
      return { path, kind: "directory", created_by: actor };
    }
    const at = new Date().toISOString();
    for (const p of paths)
      this.store.run(
        "INSERT OR IGNORE INTO directories VALUES(?,?,?)",
        p,
        actor,
        at,
      );
    return { path, kind: "directory", created_by: actor };
  }
  ls({ path = "", recursive = false, offset = 0, limit = 50 } = {}) {
    if (path) {
      this.path(path);
      if (!this.directories().some((d) => d.path === path))
        throw new AppError("Directory not found", 404);
    }
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new AppError("Invalid listing page");
    const prefix = path ? path + "/" : "";
    const entries = [
      ...this.directories().map((d) => ({ ...d, kind: "directory" })),
      ...[...this.list(), ...this.unsupported].map((f) => ({
        ...f,
        kind: "file",
      })),
    ]
      .filter(
        (e) =>
          e.path.startsWith(prefix) &&
          (recursive || !e.path.slice(prefix.length).includes("/")),
      )
      .sort((a, b) =>
        a.kind === b.kind
          ? a.path.localeCompare(b.path)
          : a.kind === "directory"
            ? -1
            : 1,
      );
    return {
      path,
      entries: entries.slice(offset, offset + limit),
      next_offset: offset + limit < entries.length ? offset + limit : null,
    };
  }
  grep({ query, path = "", case_sensitive = true, offset = 0, limit = 30 }) {
    if (typeof query !== "string" || !query || query.length > 300)
      throw new AppError("query must be 1–300 characters");
    if (path) this.path(path);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new AppError("Invalid search page");
    if (
      path &&
      !this.list().some((f) => f.path === path) &&
      !this.directories().some((d) => d.path === path)
    )
      throw new AppError("Path not found", 404);
    const needle = case_sensitive ? query : query.toLowerCase();
    const results = [];
    let matched = 0;
    for (const f of this.list().filter(
      (f) => !path || f.path === path || f.path.startsWith(path + "/"),
    )) {
      const lines = this.read(f.path).content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const at = (case_sensitive ? lines[i] : lines[i].toLowerCase()).indexOf(
          needle,
        );
        if (at < 0) continue;
        if (matched++ < offset) continue;
        if (results.length === limit)
          return { results, next_offset: offset + limit };
        const start = Math.max(0, at - 80);
        results.push({
          path: f.path,
          revision: f.revision,
          line: i + 1,
          column: at + 1,
          text: lines[i].slice(start, start + 200),
          truncated: start > 0 || lines[i].length > start + 200,
        });
      }
    }
    return { results, next_offset: null };
  }
  sed(
    { path, start_line, end_line = start_line, replacement, expected_revision },
    actor = null,
  ) {
    const file = this.read(path),
      lines = file.content.split("\n");
    if (
      !Number.isInteger(start_line) ||
      !Number.isInteger(end_line) ||
      start_line < 1 ||
      end_line < start_line ||
      end_line > lines.length
    )
      throw new AppError("Invalid line range");
    if (typeof replacement !== "string")
      throw new AppError("replacement must be a string");
    lines.splice(
      start_line - 1,
      end_line - start_line + 1,
      ...(replacement === "" ? [] : replacement.split("\n")),
    );
    return this.write(path, lines.join("\n"), expected_revision, actor);
  }
  list() {
    this.sync();
    return this.store.all(
      "SELECT path,revision,updated_by,updated_at,length(CAST(content AS BLOB)) AS bytes FROM files ORDER BY path",
    );
  }
  read(path, revision = null) {
    this.sync();
    this.path(path);
    if (revision !== null && (!Number.isInteger(revision) || revision < 1))
      throw new AppError("Revision must be a positive integer");
    const f =
      revision === null
        ? this.store.get("SELECT * FROM files WHERE path=?", path)
        : this.store.get(
            "SELECT * FROM file_versions WHERE path=? AND revision=?",
            path,
            revision,
          );
    if (!f)
      throw new AppError(
        revision === null ? "File not found" : "File revision not found",
        404,
      );
    const info = this.store.get(
      "SELECT git_commit,source,kind,execution_id FROM file_version_info WHERE path=? AND revision=?",
      path,
      f.revision,
    );
    if (
      info?.git_commit &&
      this.folder &&
      revision !== null &&
      info.kind !== "deleted"
    )
      f.content = this.folder.show(info.git_commit, path);
    return { ...f, ...info };
  }
  write(path, content, expected_revision, actor = null) {
    this.ensureWritable();
    this.path(path);
    if (actor) this.store.agent(actor);
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content) > 256000 ||
      content.includes("\0")
    )
      throw new AppError("File must be UTF-8 text, at most 256 KB");
    if (!Number.isInteger(expected_revision) || expected_revision < 0)
      throw new AppError(
        "expected_revision is required: use 0 for new files, or the revision returned by read_file",
      );
    if (this.directories().some((d) => d.path === path))
      throw new AppError("A directory conflicts with this file path");
    const old = this.store.get("SELECT * FROM files WHERE path=?", path);
    if ((old?.revision || 0) !== expected_revision)
      throw new AppError(
        "File changed. Read it again and retry with the current revision.",
        409,
      );
    const files = this.list();
    if (!old && files.length >= 100)
      throw new AppError("Project limit: 100 files");
    if (
      files.some(
        (f) => f.path.startsWith(path + "/") || path.startsWith(f.path + "/"),
      )
    )
      throw new AppError("A file conflicts with this directory path");
    if (
      files.reduce((n, f) => n + f.bytes, 0) -
        (old ? Buffer.byteLength(old.content) : 0) +
        Buffer.byteLength(content) >
      2000000
    )
      throw new AppError("Project source limit: 2 MB");
    if (this.folder) {
      this.folder.write(path, content);
      this.sync(actor, "edit");
      const saved = this.read(path);
      return {
        path,
        revision: saved.revision,
        bytes: Buffer.byteLength(content),
        updated_by: saved.updated_by,
        updated_at: saved.updated_at,
        git_commit: saved.git_commit,
      };
    }
    const revision =
        (this.store.get(
          "SELECT MAX(revision) AS n FROM file_versions WHERE path=?",
          path,
        )?.n || 0) + 1,
      at = new Date().toISOString();
    this.store.db.exec("BEGIN");
    try {
      this.store.run(
        "INSERT INTO files VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
        path,
        content,
        revision,
        actor,
        at,
      );
      this.store.run(
        "INSERT INTO file_versions VALUES(?,?,?,?,?)",
        path,
        revision,
        content,
        actor,
        at,
      );
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    return {
      path,
      revision,
      bytes: Buffer.byteLength(content),
      updated_by: actor,
      updated_at: at,
    };
  }
  edit(path, find, replace, expected_revision, actor = null) {
    const file = this.read(path);
    if (typeof find !== "string" || !find || typeof replace !== "string")
      throw new AppError("Nonempty find and string replace are required");
    if (file.content.split(find).length !== 2)
      throw new AppError(
        "Edit must match exactly once; read the file and choose a unique match",
      );
    return this.write(
      path,
      file.content.replace(find, () => replace),
      expected_revision,
      actor,
    );
  }
  versions(path) {
    this.path(path);
    this.sync();
    return this.store.all(
      "SELECT v.revision,v.updated_by,v.updated_at,i.git_commit,i.source,i.kind FROM file_versions v LEFT JOIN file_version_info i ON v.path=i.path AND v.revision=i.revision WHERE v.path=? ORDER BY v.revision DESC",
      path,
    );
  }
  record(record) {
    this.store.run(
      "INSERT INTO executions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      record.id,
      JSON.stringify(record),
    );
  }
  runs() {
    return this.store
      .all("SELECT record FROM executions ORDER BY rowid DESC LIMIT 20")
      .map((r) => JSON.parse(r.record));
  }
  snapshot() {
    return this.list().map((f) => this.read(f.path));
  }
}
