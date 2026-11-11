import { validateManifest, httpPluginTool } from "./http-plugins.js";
import { chmodSync } from "node:fs";
import { tools as toolRegistry } from "./tools/index.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export class Store {
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS plugins(name TEXT PRIMARY KEY,manifest TEXT NOT NULL,credential TEXT NOT NULL DEFAULT '');
   CREATE TABLE IF NOT EXISTS runtime(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,prompt TEXT NOT NULL,token_hash TEXT NOT NULL,status TEXT DEFAULT 'idle',error TEXT);
   CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS members(chat_id TEXT REFERENCES chats(id),agent_id TEXT REFERENCES agents(id),PRIMARY KEY(chat_id,agent_id));
   CREATE TABLE IF NOT EXISTS reads(chat_id TEXT REFERENCES chats(id),agent_id TEXT REFERENCES agents(id),last_id INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(chat_id,agent_id));
   CREATE TABLE IF NOT EXISTS message_reads(agent_id TEXT REFERENCES agents(id),message_id INTEGER,PRIMARY KEY(agent_id,message_id));
   CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT REFERENCES chats(id),sender_id TEXT,body TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
    if (!this.all("PRAGMA table_info(agents)").some((c) => c.name === "tools"))
      this.db.exec(
        "ALTER TABLE agents ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'",
      );
    this.db
      .prepare("UPDATE agents SET status='idle' WHERE status='running'")
      .run();
  }
  saveRuntime(state) {
    this.run(
      "INSERT INTO runtime VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
      JSON.stringify(state),
    );
  }
  loadRuntime() {
    const row = this.get("SELECT state FROM runtime WHERE id=1");
    return row ? JSON.parse(row.state) : null;
  }
  all(sql, ...p) {
    return this.db.prepare(sql).all(...p);
  }
  get(sql, ...p) {
    return this.db.prepare(sql).get(...p);
  }
  run(sql, ...p) {
    return this.db.prepare(sql).run(...p);
  }
  agent(id) {
    const a = this.get(
      "SELECT id,name,prompt,status,error,tools FROM agents WHERE id=?",
      id,
    );
    if (!a) throw new AppError("Agent not found", 404);
    return { ...a, tools: JSON.parse(a.tools) };
  }
  agents() {
    return this.all("SELECT id,name,prompt,status,error,tools FROM agents").map(
      (a) => ({ ...a, tools: JSON.parse(a.tools) }),
    );
  }
  plugins() {
    return this.all(
      "SELECT name,manifest,length(credential)>0 AS has_credential FROM plugins ORDER BY name",
    ).map((row) => ({
      ...JSON.parse(row.manifest),
      has_credential: !!row.has_credential,
    }));
  }
  savePlugin(input, credential) {
    const manifest = validateManifest(input);
    if (toolRegistry.has(manifest.name))
      throw new AppError("Cannot replace a built-in tool");
    if (
      credential !== undefined &&
      (typeof credential !== "string" ||
        credential.length > 4000 ||
        /[\r\n]/.test(credential))
    )
      throw new AppError(
        "Credential must be a single-line string of at most 4,000 characters",
      );
    const old = this.get(
      "SELECT manifest,credential FROM plugins WHERE name=?",
      manifest.name,
    );
    if (!old && this.plugins().length >= 20)
      throw new AppError("A project can have at most 20 HTTP plugins");
    const previous = old ? JSON.parse(old.manifest) : null;
    const sameDestination =
      previous?.endpoint === manifest.endpoint &&
      JSON.stringify(previous.auth) === JSON.stringify(manifest.auth);
    const secret =
      manifest.auth.type === "none"
        ? ""
        : credential !== undefined
          ? credential
          : sameDestination
            ? old.credential
            : "";
    this.run(
      "INSERT INTO plugins(name,manifest,credential) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET manifest=excluded.manifest,credential=excluded.credential",
      manifest.name,
      JSON.stringify(manifest),
      secret,
    );
    return this.plugins().find((p) => p.name === manifest.name);
  }
  removePlugin(name) {
    if (!this.get("SELECT name FROM plugins WHERE name=?", name))
      throw new AppError("Plugin not found", 404);
    this.db.exec("BEGIN");
    try {
      for (const agent of this.agents())
        this.run(
          "UPDATE agents SET tools=? WHERE id=?",
          JSON.stringify(agent.tools.filter((t) => t !== name)),
          agent.id,
        );
      this.run("DELETE FROM plugins WHERE name=?", name);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true };
  }
  availableTools() {
    const registry = new Map(toolRegistry);
    for (const manifest of this.plugins())
      registry.set(
        manifest.name,
        httpPluginTool(
          manifest,
          () =>
            this.get(
              "SELECT credential FROM plugins WHERE name=?",
              manifest.name,
            )?.credential || "",
        ),
      );
    return registry;
  }
  validateTools(tools) {
    if (
      !Array.isArray(tools) ||
      tools.some((t) => !this.availableTools().has(t))
    )
      throw new AppError(
        "Supported optional tools: " +
          [...this.availableTools().keys()].join(", "),
      );
    return [...new Set(tools)];
  }
  setAgentTools(id, tools) {
    return this.updateAgent(id, { tools });
  }
  updateAgent(id, { name, prompt, tools } = {}) {
    const current = this.agent(id);
    const nextName =
      name === undefined ? current.name : String(name ?? "").trim();
    const nextPrompt =
      prompt === undefined ? current.prompt : String(prompt ?? "");
    if (!nextName || !nextPrompt.trim())
      throw new AppError("Name and system prompt are required");
    if (
      nextName !== current.name &&
      this.agents().some(
        (a) => a.id !== id && a.name.toLowerCase() === nextName.toLowerCase(),
      )
    )
      throw new AppError("An agent with this name already exists");
    const nextTools =
      tools === undefined ? current.tools : this.validateTools(tools);
    this.run(
      "UPDATE agents SET name=?, prompt=?, tools=? WHERE id=?",
      nextName,
      nextPrompt,
      JSON.stringify(nextTools),
      id,
    );
    return this.agent(id);
  }
  createAgent(name, prompt, tools = []) {
    tools = this.validateTools(tools);
    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof prompt !== "string" ||
      !prompt.trim()
    )
      throw new AppError("Name and system prompt are required");
    const id = randomUUID(),
      token = randomBytes(32).toString("hex");
    this.run(
      "INSERT INTO agents(id,name,prompt,token_hash,tools) VALUES(?,?,?,?,?)",
      id,
      name.trim(),
      prompt,
      hash(token),
      JSON.stringify(tools),
    );
    return { ...this.agent(id), token };
  }
  authenticate(token) {
    if (!token) return null;
    return this.get("SELECT id FROM agents WHERE token_hash=?", hash(token))
      ?.id;
  }
  requireMember(chat, id) {
    if (
      !this.get(
        "SELECT 1 FROM members WHERE chat_id=? AND agent_id=?",
        chat,
        id,
      )
    )
      throw new AppError("Conversation unavailable", 403);
  }
  createChat(name, kind, members, actor = null, summary = "") {
    if (!["self", "direct", "group"].includes(kind) || !Array.isArray(members))
      throw new AppError("Invalid conversation");
    members = [...new Set(members)];
    if (
      (kind === "self" && members.length !== 1) ||
      (kind === "direct" && members.length !== 2) ||
      (kind === "group" && members.length < 2)
    )
      throw new AppError(
        "Self chats require one agent, direct chats two, and groups at least two",
      );
    if (actor && !members.includes(actor))
      throw new AppError("You must belong to conversations you create", 403);
    members.forEach((id) => this.agent(id));
    if (kind === "direct") {
      const existing = this.get(
        `SELECT c.id FROM chats c JOIN members a ON c.id=a.chat_id JOIN members b ON c.id=b.chat_id WHERE c.kind='direct' AND a.agent_id=? AND b.agent_id=?`,
        ...members,
      );
      if (existing) return this.chat(existing.id);
    }
    if (typeof name !== "string" || !name.trim())
      throw new AppError("Conversation name required");
    if (typeof summary !== "string")
      throw new AppError("Summary must be a string");
    if (!summary.trim())
      summary =
        kind === "self"
          ? `Private working notes for ${this.agent(members[0]).name}.`
          : kind === "direct"
            ? `Private conversation between ${members.map((id) => this.agent(id).name).join(" and ")}.`
            : `Shared workspace for ${members.map((id) => this.agent(id).name).join(", ")}.`;
    const id = randomUUID();
    this.db.exec("BEGIN");
    try {
      this.run(
        "INSERT INTO chats VALUES(?,?,?,?,?)",
        id,
        name.trim(),
        kind,
        summary,
        new Date().toISOString(),
      );
      members.forEach((a) =>
        this.run("INSERT INTO members VALUES(?,?)", id, a),
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.chat(id);
  }
  chat(id) {
    const c = this.get("SELECT * FROM chats WHERE id=?", id);
    if (!c) throw new AppError("Conversation not found", 404);
    return {
      ...c,
      members: this.all("SELECT agent_id FROM members WHERE chat_id=?", id).map(
        (x) => x.agent_id,
      ),
    };
  }
  chats(actor = null) {
    const rows = actor
      ? this.all(
          "SELECT c.* FROM chats c JOIN members m ON c.id=m.chat_id WHERE m.agent_id=?",
          actor,
        )
      : this.all("SELECT * FROM chats ORDER BY created_at");
    if (!rows.length) return [];
    const membersByChat = new Map(rows.map((c) => [c.id, []]));
    for (const m of this.all("SELECT chat_id,agent_id FROM members"))
      membersByChat.get(m.chat_id)?.push(m.agent_id);
    return rows.map((c) => ({ ...c, members: membersByChat.get(c.id) || [] }));
  }
  addMember(chat, id, actor = null) {
    if (actor) this.requireMember(chat, actor);
    if (this.chat(chat).kind !== "group")
      throw new AppError("Direct chat membership cannot change");
    this.agent(id);
    this.run("INSERT OR IGNORE INTO members VALUES(?,?)", chat, id);
    return this.chat(chat);
  }
  messages(chat, actor = null) {
    if (actor) this.requireMember(chat, actor);
    else this.chat(chat);
    return this.all(
      "SELECT * FROM (SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 200) ORDER BY id",
      chat,
    );
  }
  send(chat, sender, body) {
    if (sender) this.requireMember(chat, sender);
    else this.chat(chat);
    if (typeof body !== "string" || !body.trim())
      throw new AppError("Message body is required");
    const r = this.run(
      "INSERT INTO messages(chat_id,sender_id,body,created_at) VALUES(?,?,?,?)",
      chat,
      sender,
      body.trim(),
      new Date().toISOString(),
    );
    return this.get(
      "SELECT * FROM messages WHERE id=?",
      Number(r.lastInsertRowid),
    );
  }
  status(id, status, error = null) {
    this.run(
      "UPDATE agents SET status=?,error=? WHERE id=?",
      status,
      error,
      id,
    );
  }
  updateChat(id, name, summary, actor = null) {
    if (actor) this.requireMember(id, actor);
    this.chat(id);
    if (typeof name !== "string" || !name.trim() || typeof summary !== "string")
      throw new AppError("Valid name and summary required");
    this.run(
      "UPDATE chats SET name=?,summary=? WHERE id=?",
      name.trim(),
      summary,
      id,
    );
    return this.chat(id);
  }
  read(chat, actor, through) {
    this.requireMember(chat, actor);
    const max = this.get(
      "SELECT COALESCE(MAX(id),0) AS n FROM messages WHERE chat_id=?",
      chat,
    ).n;
    if (!Number.isInteger(through) || through < 0 || through > max)
      throw new AppError("Invalid read position");
    this.run(
      "INSERT INTO reads VALUES(?,?,?) ON CONFLICT(chat_id,agent_id) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)",
      chat,
      actor,
      through,
    );
    return { ok: true };
  }
  markSeen(actor, references) {
    for (const ref of references) {
      this.requireMember(ref.chat_id, actor);
      if (
        !this.get(
          "SELECT 1 FROM messages WHERE id=? AND chat_id=?",
          ref.message_id,
          ref.chat_id,
        )
      )
        throw new AppError("Message unavailable", 403);
      this.run(
        "INSERT OR IGNORE INTO message_reads VALUES(?,?)",
        actor,
        ref.message_id,
      );
    }
    for (const chat of new Set(references.map((r) => r.chat_id))) {
      const last =
        this.get(
          "SELECT last_id FROM reads WHERE chat_id=? AND agent_id=?",
          chat,
          actor,
        )?.last_id || 0;
      const first = this.get(
        "SELECT MIN(id) AS id FROM messages WHERE chat_id=? AND id>? AND (sender_id IS NULL OR sender_id!=?) AND NOT EXISTS(SELECT 1 FROM message_reads r WHERE r.message_id=messages.id AND r.agent_id=?)",
        chat,
        last,
        actor,
        actor,
      ).id;
      const through = this.get(
        "SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE chat_id=? AND (? IS NULL OR id<?)",
        chat,
        first,
        first,
      ).id;
      this.read(chat, actor, through);
    }
  }
  readState(chat, actor) {
    const last =
      this.get(
        "SELECT last_id FROM reads WHERE chat_id=? AND agent_id=?",
        chat,
        actor,
      )?.last_id || 0;
    const unread = this.get(
      "SELECT COUNT(*) AS n, MIN(id) AS first_id FROM messages WHERE chat_id=? AND id>? AND (sender_id IS NULL OR sender_id!=?) AND NOT EXISTS(SELECT 1 FROM message_reads r WHERE r.message_id=messages.id AND r.agent_id=?)",
      chat,
      last,
      actor,
      actor,
    );
    return {
      agent_id: actor,
      last_read_id: last,
      unread_count: unread.n,
      first_unread_id: unread.first_id ?? null,
    };
  }
  snapshot(actor = null) {
    const seen = actor
      ? new Set(
          this.all(
            "SELECT message_id FROM message_reads WHERE agent_id=?",
            actor,
          ).map((r) => r.message_id),
        )
      : null;
    return {
      agents: actor
        ? this.agents().map(({ id, name, status }) => ({ id, name, status }))
        : this.agents(),
      chats: this.chats(actor).map((c) => {
        const messages = this.messages(c.id, actor);
        const read_states = (actor ? [actor] : c.members).map((id) =>
          this.readState(c.id, id),
        );
        return {
          ...c,
          messages,
          read_states,
          ...(actor
            ? {
                new_since_last_read: messages.filter(
                  (m) =>
                    m.id > read_states[0].last_read_id &&
                    m.sender_id !== actor &&
                    !seen.has(m.id),
                ),
              }
            : {}),
        };
      }),
    };
  }
}
