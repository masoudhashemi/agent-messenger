import { randomUUID } from "node:crypto";
import { AppError } from "./store.js";

const statuses = new Set(["active", "awaiting_input", "blocked", "resolved"]);
export class Groups {
  constructor(store) {
    this.store = store;
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS group_contracts(chat_id TEXT PRIMARY KEY REFERENCES chats(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_decisions(id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),author TEXT,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_events(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT REFERENCES chats(id),actor TEXT,event TEXT,data TEXT,created_at TEXT);`);
  }
  info(chatId) {
    const chat = this.store.get("SELECT * FROM chats WHERE id=?", chatId);
    if (!chat || chat.kind !== "group") return null;
    const row = this.store.get(
      "SELECT data FROM group_contracts WHERE chat_id=?",
      chatId,
    );
    const members = this.store
      .all(
        "SELECT agent_id FROM members WHERE chat_id=? ORDER BY rowid",
        chatId,
      )
      .map((m) => m.agent_id);
    const saved = row ? JSON.parse(row.data) : {};
    return {
      purpose: chat.summary || chat.name,
      owner_id: members[0],
      roles: {},
      status: "active",
      deliverables: [],
      completion_criteria: "",
      blockers: [],
      final_message_id: null,
      ...saved,
      decision_count: this.store.get(
        "SELECT count(*) AS n FROM group_decisions WHERE chat_id=?",
        chatId,
      ).n,
    };
  }
  scope(chatId, actor, owner = false) {
    if (typeof chatId !== "string" || !chatId)
      throw new AppError("chat_id is required");
    if (actor) this.store.requireMember(chatId, actor);
    const info = this.info(chatId);
    if (!info) throw new AppError("A group conversation is required");
    if (owner && actor && info.owner_id !== actor)
      throw new AppError(
        "Only the group owner or operator can change its contract or resolve it",
        403,
      );
    return info;
  }
  update(chatId, patch, actor = null, workspace = null) {
    const previous = this.scope(chatId, actor, true);
    const keys = [
      "purpose",
      "owner_id",
      "roles",
      "status",
      "deliverables",
      "completion_criteria",
      "blockers",
      "final_message_id",
    ];
    const next = {
      ...previous,
      ...Object.fromEntries(
        keys.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]),
      ),
    };
    if (typeof next.purpose !== "string" || !next.purpose.trim())
      throw new AppError("Group purpose is required");
    const members = this.store.chat(chatId).members;
    if (!members.includes(next.owner_id))
      throw new AppError("Group owner must be a member");
    if (!statuses.has(next.status)) throw new AppError("Invalid group status");
    if (
      !next.roles ||
      Array.isArray(next.roles) ||
      typeof next.roles !== "object" ||
      Object.entries(next.roles).some(
        ([id, role]) => !members.includes(id) || typeof role !== "string",
      )
    )
      throw new AppError(
        "Roles must map group member IDs to role descriptions",
      );
    for (const field of ["deliverables", "blockers"])
      if (
        !Array.isArray(next[field]) ||
        next[field].some((v) => typeof v !== "string" || !v.trim())
      )
        throw new AppError(`${field} must contain nonempty strings`);
    if (typeof next.completion_criteria !== "string")
      throw new AppError("completion_criteria must be text");
    for (const path of next.deliverables) {
      if (!workspace)
        throw new AppError("Workspace required for group deliverables");
      workspace.path(path);
    }
    if (next.status === "blocked" && !next.blockers.length)
      throw new AppError(
        "Explain the blockers before marking the group blocked",
      );
    if (next.final_message_id !== null) {
      if (!Number.isInteger(next.final_message_id))
        throw new AppError("final_message_id must be a message ID");
      if (
        !this.store.get(
          "SELECT id FROM messages WHERE id=? AND chat_id=?",
          next.final_message_id,
          chatId,
        )
      )
        throw new AppError("The final report must be a message in this group");
    }
    if (next.status === "resolved") {
      if (next.blockers.length)
        throw new AppError(
          "Resolve blockers or mark the group blocked instead",
        );
      if (!next.completion_criteria.trim() || !next.final_message_id)
        throw new AppError(
          "Resolving a group requires completion criteria and a final report message",
        );
      if (
        this.store
          .all("SELECT data FROM group_decisions WHERE chat_id=?", chatId)
          .some((row) => JSON.parse(row.data).status === "proposed")
      )
        throw new AppError(
          "Accept or reject pending decisions before resolving the group",
        );
      for (const path of next.deliverables) {
        try {
          if (workspace.read(path).kind === "deleted") throw new Error();
        } catch {
          throw new AppError("Missing group deliverable: " + path);
        }
      }
    }
    delete next.decision_count;
    this.store.run(
      "INSERT INTO group_contracts VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET data=excluded.data",
      chatId,
      JSON.stringify(next),
    );
    this.store.run(
      "INSERT INTO group_events(chat_id,actor,event,data,created_at) VALUES(?,?,?,?,?)",
      chatId,
      actor,
      "contract_updated",
      JSON.stringify({ before: previous, after: next }),
      new Date().toISOString(),
    );
    return this.info(chatId);
  }
  decisions(chatId, actor, { offset = 0, limit = 20 } = {}) {
    this.scope(chatId, actor);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 30
    )
      throw new AppError(
        "Decision offset must be nonnegative and limit must be 1–30",
      );
    const rows = this.store.all(
      "SELECT * FROM group_decisions WHERE chat_id=? ORDER BY rowid LIMIT ? OFFSET ?",
      chatId,
      limit + 1,
      offset,
    );
    return {
      results: rows
        .slice(0, limit)
        .map(({ data, ...r }) => ({ ...r, ...JSON.parse(data) })),
      next_offset: rows.length > limit ? offset + limit : null,
    };
  }
  decide(chatId, input, actor = null) {
    const info = this.scope(chatId, actor);
    if (
      input.decision_id !== undefined &&
      (typeof input.decision_id !== "string" || !input.decision_id.trim())
    )
      throw new AppError("decision_id must be a nonempty string");
    if (info.status === "resolved")
      throw new AppError("Reopen the group before changing decisions");
    const old = input.decision_id
      ? this.store.get(
          "SELECT * FROM group_decisions WHERE id=? AND chat_id=?",
          input.decision_id,
          chatId,
        )
      : null;
    if (input.decision_id && !old) {
      const error = new AppError(
        "Decision not found. Use the exact decision ID returned by record_decision or read_group; omit decision_id when creating a decision.",
        404,
      );
      error.validation = true;
      throw error;
    }
    if (old && actor && actor !== old.author && actor !== info.owner_id)
      throw new AppError(
        "Only the author, owner or operator can edit this decision",
        403,
      );
    const prior = old ? JSON.parse(old.data) : {};
    const data = {
      title: "",
      rationale: "",
      status: "proposed",
      evidence: [],
      ...prior,
      ...Object.fromEntries(
        ["title", "rationale", "status", "evidence"]
          .filter((k) => input[k] !== undefined)
          .map((k) => [k, input[k]]),
      ),
    };
    if (
      ![data.title, data.rationale].every(
        (v) => typeof v === "string" && v.trim(),
      )
    )
      throw new AppError("Decision title and rationale are required");
    if (!["proposed", "accepted", "rejected"].includes(data.status))
      throw new AppError("Invalid decision status");
    if (
      actor &&
      actor !== info.owner_id &&
      (data.status !== "proposed" || (old && prior.status !== "proposed"))
    )
      throw new AppError(
        "Only the owner or operator can accept, reject, or reopen a decision",
        403,
      );
    if (!Array.isArray(data.evidence))
      throw new AppError(
        "Evidence must be an array of source URLs or group message IDs",
      );
    for (const ref of data.evidence) {
      if (Number.isInteger(ref)) {
        if (
          !this.store.get(
            "SELECT id FROM messages WHERE id=? AND chat_id=?",
            ref,
            chatId,
          )
        )
          throw new AppError(
            "Message evidence must already be shared in this group; private references are not copied",
          );
      } else {
        try {
          const url = new URL(ref);
          if (
            typeof ref !== "string" ||
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new Error();
        } catch {
          throw new AppError(
            "Evidence must be a public HTTP(S) URL or a message ID in this group",
          );
        }
      }
    }
    if (data.status === "accepted" && !data.evidence.length)
      throw new AppError("Accepted decisions require evidence references");
    const id = old?.id || randomUUID();
    this.store.run(
      "INSERT INTO group_decisions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      id,
      chatId,
      old?.author || actor,
      JSON.stringify(data),
      old?.created_at || new Date().toISOString(),
    );
    this.store.run(
      "INSERT INTO group_events(chat_id,actor,event,data,created_at) VALUES(?,?,?,?,?)",
      chatId,
      actor,
      "decision_updated",
      JSON.stringify({
        decision_id: id,
        before: old ? prior : null,
        after: data,
      }),
      new Date().toISOString(),
    );
    const message = this.store.send(
      chatId,
      actor,
      `Decision ${data.status}: ${data.title}\n\n${data.rationale}\n\nEvidence: ${data.evidence.map((ref) => (typeof ref === "number" ? "Message #" + ref : ref)).join(", ") || "Not yet provided"}`,
    );
    return { id, chat_id: chatId, message_id: message.id, ...data };
  }
  history(chatId, actor, { offset = 0, limit = 20 } = {}) {
    this.scope(chatId, actor);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 30
    )
      throw new AppError(
        "History offset must be nonnegative and limit must be 1–30",
      );
    const rows = this.store.all(
      "SELECT * FROM group_events WHERE chat_id=? ORDER BY id DESC LIMIT ? OFFSET ?",
      chatId,
      limit + 1,
      offset,
    );
    return {
      results: rows
        .slice(0, limit)
        .map((r) => ({ ...r, data: JSON.parse(r.data) })),
      next_offset: rows.length > limit ? offset + limit : null,
    };
  }
  ensure(name, purpose, members, owner) {
    if (typeof purpose !== "string" || !purpose.trim())
      throw new AppError("Group purpose is required");
    const ids = [...new Set(members)];
    const normalized = purpose.trim().toLowerCase();
    const existing = this.store
      .chats(owner)
      .find(
        (c) =>
          c.kind === "group" &&
          this.info(c.id).purpose.trim().toLowerCase() === normalized &&
          c.members.length === ids.length &&
          ids.every((id) => c.members.includes(id)),
      );
    if (existing) return existing;
    const chat = this.store.createChat(name, "group", ids, owner, purpose);
    this.update(chat.id, { purpose, owner_id: owner }, null);
    return this.store.chat(chat.id);
  }
}
