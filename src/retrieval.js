import { textPage } from "./artifacts.js";
import { validateAction } from "./action-validation.js";
import { AppError } from "./store.js";
import { lineDiff } from "../public/diff.js";
export const RETRIEVAL_TOOLS = new Set([
  "read_group",
  "list_sources",
  "read_source",
  "read_artifact",
  "search_artifact",
  "read_chat_details",
  "ls",
  "grep",
  "list_chats",
  "list_agents",
  "read_chat",
  "read_message",
  "search_messages",
  "search_chats",
  "search_files",
  "search_file_history",
  "search_executions",
  "read_file",
  "list_files",
  "list_file_versions",
  "read_file_diff",
  "list_executions",
  "read_execution",
  "focus_chat",
]);
export const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
function integer(value, fallback, min, max) {
  value = value ?? fallback;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new AppError(`Expected an integer between ${min} and ${max}`);
  return value;
}
function query(value) {
  if (typeof value !== "string" || value.length > 300)
    throw new AppError("Search query must be 1–300 characters");
  const terms = value.match(/[\p{L}\p{N}]+/gu) || [];
  if (!terms.length || terms.length > 20)
    throw new AppError("Use 1–20 search words");
  return terms.map((t) => '"' + t + '"').join(" AND ");
}
function excerpt(text, q, limit = 300) {
  const terms = String(q).match(/[\p{L}\p{N}]+/gu) || [];
  const at = Math.max(
    0,
    ...terms
      .map((t) => text.toLowerCase().indexOf(t.toLowerCase()))
      .filter((n) => n >= 0)
      .slice(0, 1),
  );
  const start = Math.max(0, at - 80);
  return { snippet: text.slice(start, start + limit), offset: start };
}
function page(items, offset, limit, maxBytes = 12000) {
  const selected = [];
  for (const item of items.slice(0, limit)) {
    if (bytes([...selected, item]) > maxBytes) {
      if (!selected.length)
        throw new AppError(
          "Result is too large for a page; use a narrower read",
        );
      break;
    }
    selected.push(item);
  }
  return {
    results: selected,
    next_offset:
      items.length > selected.length ? offset + selected.length : null,
  };
}
export class Retrieval {
  constructor(store, workspace = null) {
    this.store = store;
    this.workspace = workspace;
    this.index("message_search", "messages", ["body"]);
    this.index("chat_search", "chats", ["name", "summary"]);
    if (workspace) {
      this.index("file_search", "files", ["path", "content"]);
      this.index("version_search", "file_versions", ["path", "content"]);
      this.index("execution_search", "executions", ["record"]);
    }
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS agent_focus(agent_id TEXT PRIMARY KEY,chat_id TEXT,self_chat_id TEXT);",
    );
  }
  index(name, table, columns) {
    if (this.store.get("SELECT 1 FROM sqlite_master WHERE name=?", name))
      return;
    const list = columns.join(","),
      old = columns.map((c) => "old." + c).join(","),
      fresh = columns.map((c) => "new." + c).join(",");
    this.store.db
      .exec(`BEGIN; CREATE VIRTUAL TABLE ${name} USING fts5(${list},content='${table}',content_rowid='rowid');
   CREATE TRIGGER ${name}_insert AFTER INSERT ON ${table} BEGIN INSERT INTO ${name}(rowid,${list}) VALUES(new.rowid,${fresh}); END;
   CREATE TRIGGER ${name}_delete AFTER DELETE ON ${table} BEGIN INSERT INTO ${name}(${name},rowid,${list}) VALUES('delete',old.rowid,${old}); END;
   CREATE TRIGGER ${name}_update AFTER UPDATE ON ${table} BEGIN INSERT INTO ${name}(${name},rowid,${list}) VALUES('delete',old.rowid,${old}); INSERT INTO ${name}(rowid,${list}) VALUES(new.rowid,${fresh}); END;
   INSERT INTO ${name}(${name}) VALUES('rebuild'); COMMIT;`);
  }
  scope(actor, chat) {
    this.store.agent(actor);
    if (chat) this.store.requireMember(chat, actor);
  }
  focus(actor, chat, self = false) {
    this.scope(actor, chat);
    if (self && this.store.chat(chat).kind !== "self")
      throw new AppError("Working notebook must be a self chat");
    const column = self ? "self_chat_id" : "chat_id";
    this.store.run(
      `INSERT INTO agent_focus(agent_id,${column}) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET ${column}=excluded.${column}`,
      actor,
      chat,
    );
    return { chat_id: chat };
  }
  chatList(actor, { offset = 0, limit = 20 } = {}) {
    this.scope(actor);
    offset = integer(offset, 0, 0, 1000000);
    limit = integer(limit, 20, 1, 50);
    const rows = this.store.all(
      `SELECT c.*,COALESCE((SELECT MAX(id) FROM messages WHERE chat_id=c.id),0) AS last_message_id FROM chats c JOIN members m ON m.chat_id=c.id WHERE m.agent_id=? ORDER BY last_message_id DESC,c.id LIMIT ? OFFSET ?`,
      actor,
      limit + 1,
      offset,
    );
    const membersByChat = new Map(rows.map((c) => [c.id, []]));
    if (rows.length) {
      for (const m of this.store.all("SELECT chat_id,agent_id FROM members"))
        membersByChat.get(m.chat_id)?.push(m.agent_id);
    }
    const chats = rows.map((c) => ({
      ...(bytes(c) > 4000
        ? {
            id: c.id,
            kind: c.kind,
            last_message_id: c.last_message_id,
            metadata_loaded: false,
            read_with: { type: "read_chat_details", chat_id: c.id },
          }
        : c),
      ...(c.kind === "group"
        ? {
            group_status: this.store.groups.info(c.id).status,
            group_owner: this.store.groups.info(c.id).owner_id,
            read_group_with: { type: "read_group", chat_id: c.id },
          }
        : {}),
      members: membersByChat.get(c.id) || [],
      ...this.store.readState(c.id, actor),
    }));
    return page(chats, offset, limit);
  }
  readChat(actor, a) {
    this.scope(actor, a.chat_id);
    const limit = integer(a.limit, 10, 1, 30),
      after = integer(a.after_message_id, 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = this.store.all(
      "SELECT * FROM messages WHERE chat_id=? AND id>? ORDER BY id LIMIT ?",
      a.chat_id,
      after,
      limit + 1,
    );
    const messages = [];
    for (const row of rows.slice(0, limit)) {
      const entry = {
        id: row.id,
        chat_id: row.chat_id,
        sender_id: row.sender_id,
        created_at: row.created_at,
        ...(bytes(row) > 6000
          ? {
              body_loaded: false,
              body_truncated: true,
              total_characters: row.body.length,
              read_with: { type: "read_message", message_id: row.id },
            }
          : { body: row.body, body_truncated: false }),
      };
      if (messages.length && bytes([...messages, entry]) > 7000) break;
      messages.push(entry);
    }
    return {
      chat_id: a.chat_id,
      messages,
      next_after_message_id:
        rows.length > messages.length ? (messages.at(-1)?.id ?? after) : null,
    };
  }
  readMessage(actor, a) {
    const m = this.store.get(
      "SELECT * FROM messages WHERE id=?",
      integer(a.message_id, 0, 1, Number.MAX_SAFE_INTEGER),
    );
    if (!m) throw new AppError("Message unavailable", 403);
    this.scope(actor, m.chat_id);
    const offset = integer(a.offset, 0, 0, m.body.length),
      limit = integer(a.limit, 4000, 1, 64000);
    const part = textPage(m.body, offset, limit);
    return {
      ...m,
      body: part.text,
      offset,
      total_characters: m.body.length,
      next_offset: part.next_offset,
      body_truncated: !part.complete,
      complete: part.complete,
    };
  }
  searchMessages(actor, a) {
    this.scope(actor);
    const q = query(a.query),
      offset = integer(a.offset, 0, 0, 1000000),
      limit = integer(a.limit, 10, 1, 30);
    if (
      a.chat_ids !== undefined &&
      (!Array.isArray(a.chat_ids) ||
        a.chat_ids.length > 30 ||
        !a.chat_ids.length)
    )
      throw new AppError("chat_ids must contain 1–30 conversations");
    for (const id of a.chat_ids || []) this.scope(actor, id);
    const filter = a.chat_ids
      ? " AND m.chat_id IN (" + a.chat_ids.map(() => "?").join(",") + ")"
      : "";
    const rows = this.store.all(
      `SELECT m.*,c.name AS chat_name,c.kind AS chat_kind FROM messages m JOIN members member ON member.chat_id=m.chat_id AND member.agent_id=? JOIN chats c ON c.id=m.chat_id JOIN message_search ON message_search.rowid=m.id WHERE message_search MATCH ?${filter} ORDER BY m.id DESC LIMIT ? OFFSET ?`,
      actor,
      q,
      ...(a.chat_ids || []),
      limit + 1,
      offset,
    );
    return page(
      rows.map(({ body, ...m }) => ({
        ...m,
        ...excerpt(body, a.query),
        message_id: m.id,
      })),
      offset,
      limit,
    );
  }
  fileRead(a) {
    const file = this.workspace.read(a.path, a.revision ?? null);
    const lines = file.content.split("\n");
    const start = integer(a.start_line, 1, 1, Math.max(1, lines.length));
    const end = Math.min(
      lines.length,
      integer(
        a.end_line,
        Math.min(lines.length, start + 79),
        start,
        Number.MAX_SAFE_INTEGER,
      ),
    );
    const column = integer(a.start_column, 0, 0, lines[start - 1].length);
    let content = "",
      last = start,
      next = null;
    for (let i = start - 1; i < end; i++) {
      const raw =
        lines[i].slice(i === start - 1 ? column : 0) +
        (i < lines.length - 1 ? "\n" : "");
      const room = 6000 - content.length;
      content += raw.slice(0, room);
      last = i + 1;
      if (raw.length > room) {
        next = {
          start_line: i + 1,
          start_column: (i === start - 1 ? column : 0) + room,
        };
        break;
      }
      if (content.length >= 6000 && i + 1 < lines.length) {
        next = { start_line: i + 2, start_column: 0 };
        break;
      }
    }
    if (!next && last < lines.length)
      next = { start_line: last + 1, start_column: 0 };
    return {
      ...file,
      content,
      start_line: start,
      start_column: column,
      end_line: last,
      total_lines: lines.length,
      next,
      content_truncated: start > 1 || column > 0 || next !== null,
    };
  }
  searchFiles(a, history = false) {
    const q = query(a.query),
      offset = integer(a.offset, 0, 0, 1000000),
      limit = integer(a.limit, 10, 1, 30),
      table = history ? "file_versions" : "files",
      index = history ? "version_search" : "file_search";
    if (a.path) this.workspace.path(a.path);
    const rows = this.store.all(
      `SELECT f.* FROM ${table} f JOIN ${index} ON ${index}.rowid=f.rowid WHERE ${index} MATCH ?${a.path ? " AND f.path=?" : ""} ORDER BY f.path,f.revision DESC LIMIT ? OFFSET ?`,
      q,
      ...(a.path ? [a.path] : []),
      limit + 1,
      offset,
    );
    return page(
      rows.map(({ content, ...f }) => {
        const hit = excerpt(content, a.query);
        return {
          ...f,
          ...hit,
          start_line: content.slice(0, hit.offset).split("\n").length,
        };
      }),
      offset,
      limit,
    );
  }
  executions(a, search = false) {
    const offset = integer(a.offset, 0, 0, 1000000),
      limit = integer(a.limit, 10, 1, 30);
    const terms = search
      ? (query(a.query),
        String(a.query)
          .toLowerCase()
          .match(/[\p{L}\p{N}]+/gu) || [])
      : [];
    const scan = (record) => {
      const found = new Set(
        terms.filter((t) => JSON.stringify(record).toLowerCase().includes(t)),
      );
      let preview = null;
      for (const stream of ["stdout", "stderr"]) {
        const chunks = record[stream + "_artifact_id"]
          ? this.store.artifacts.chunks(record[stream + "_artifact_id"])
          : [record[stream] || ""];
        let tail = "",
          position = 0;
        for (const chunk of chunks) {
          const text = tail + chunk,
            lower = text.toLowerCase();
          const matches = terms.filter((t) => lower.includes(t));
          for (const term of matches) found.add(term);
          if (!preview && matches.length) {
            const part = excerpt(text, a.query);
            preview = {
              ...part,
              offset: position - tail.length + part.offset,
              stream,
            };
          }
          position += chunk.length;
          tail = text.slice(-Math.max(80, ...terms.map((t) => t.length)));
        }
      }
      return {
        matches: terms.every((t) => found.has(t)),
        preview: preview || { snippet: "", offset: 0, stream: "stderr" },
      };
    };
    let rows;
    if (search) {
      rows = [];
      let skipped = 0;
      for (const row of this.store.db
        .prepare("SELECT record FROM executions ORDER BY rowid DESC")
        .iterate()) {
        const match = scan(JSON.parse(row.record));
        if (!match.matches) continue;
        if (skipped++ < offset) continue;
        rows.push({ ...row, preview: match.preview });
        if (rows.length >= limit + 1) break;
      }
    } else
      rows = this.store.all(
        "SELECT record FROM executions ORDER BY rowid DESC LIMIT ? OFFSET ?",
        limit + 1,
        offset,
      );
    return page(
      rows.map((r) => {
        let { stdout, stderr, ...record } = JSON.parse(r.record);
        return {
          id: record.id,
          path: record.path,
          actor: record.actor,
          status: record.status,
          started_at: record.started_at,
          ended_at: record.ended_at,
          exit_code: record.exit_code,
          duration_ms: record.duration_ms,
          ...(record.error
            ? bytes(record.error) <= 4000
              ? { error: record.error }
              : { error_loaded: false }
            : {}),
          ...(search ? r.preview : {}),
          read_with: { type: "read_execution", execution_id: record.id },
        };
      }),
      offset,
      limit,
    );
  }
  execute(actor, a) {
    validateAction(a);
    this.workspace?.sync();
    this.scope(actor);
    if (!RETRIEVAL_TOOLS.has(a.type))
      throw new AppError("Unknown retrieval tool");
    if (a.type === "read_group") {
      this.store.groups.scope(a.chat_id, actor);
      return {
        ...this.store.chat(a.chat_id),
        ...(a.view === "history"
          ? { history: this.store.groups.history(a.chat_id, actor, a) }
          : { decisions: this.store.groups.decisions(a.chat_id, actor, a) }),
      };
    }
    if (a.type === "list_sources") return this.store.sources.list(actor, a);
    if (a.type === "read_source") return this.store.sources.read(actor, a);
    if (a.type === "read_artifact")
      return this.store.artifacts.read(a.artifact_id, actor, a);
    if (a.type === "search_artifact")
      return this.store.artifacts.search(a.artifact_id, actor, a);
    if (a.type === "read_chat_details") {
      this.scope(actor, a.chat_id);
      return this.store.chat(a.chat_id);
    }
    if (a.type === "list_chats") return this.chatList(actor, a);
    if (a.type === "list_agents") {
      const offset = integer(a.offset, 0, 0, 1000000),
        limit = integer(a.limit, 20, 1, 50);
      return page(
        this.store.all(
          "SELECT id,name,status FROM agents ORDER BY rowid LIMIT ? OFFSET ?",
          limit + 1,
          offset,
        ),
        offset,
        limit,
      );
    }
    if (a.type === "read_chat") return this.readChat(actor, a);
    if (a.type === "read_message") return this.readMessage(actor, a);
    if (a.type === "search_chats") {
      const offset = integer(a.offset, 0, 0, 1000000),
        limit = integer(a.limit, 10, 1, 30);
      const rows = this.store.all(
        "SELECT c.* FROM chats c JOIN members m ON m.chat_id=c.id AND m.agent_id=? JOIN chat_search ON chat_search.rowid=c.rowid WHERE chat_search MATCH ? ORDER BY c.created_at DESC,c.id LIMIT ? OFFSET ?",
        actor,
        query(a.query),
        limit + 1,
        offset,
      );
      return page(
        rows.map((c) => ({
          chat_id: c.id,
          chat_name: c.name,
          kind: c.kind,
          ...excerpt(c.summary, a.query),
          ...this.store.readState(c.id, actor),
        })),
        offset,
        limit,
      );
    }
    if (a.type === "search_messages") return this.searchMessages(actor, a);
    if (a.type === "focus_chat") return this.focus(actor, a.chat_id);
    if (!this.workspace) throw new AppError("Project files are unavailable");
    if (a.type === "ls") return this.workspace.ls(a);
    if (a.type === "grep") return this.workspace.grep(a);
    if (a.type === "read_file") return this.fileRead(a);
    if (a.type === "list_files") {
      const offset = integer(a.offset, 0, 0, 1000000),
        limit = integer(a.limit, 30, 1, 50);
      return page(
        this.workspace.list().slice(offset, offset + limit + 1),
        offset,
        limit,
      );
    }
    if (a.type === "search_files" || a.type === "search_file_history")
      return this.searchFiles(a, a.type === "search_file_history");
    if (a.type === "list_file_versions") {
      const offset = integer(a.offset, 0, 0, 1000000),
        limit = integer(a.limit, 20, 1, 50);
      return page(
        this.workspace.versions(a.path).slice(offset, offset + limit + 1),
        offset,
        limit,
      );
    }
    if (a.type === "read_file_diff") {
      const file = this.workspace.read(a.path, a.revision ?? null),
        before =
          file.revision > 1
            ? this.workspace.read(a.path, file.revision - 1).content
            : "";
      const offset = integer(a.offset, 0, 0, 1000000),
        limit = integer(a.limit, 40, 1, 80);
      const rows = lineDiff(before, file.content),
        results = [];
      let rowOffset = offset,
        column = integer(a.text_offset, 0, 0, Number.MAX_SAFE_INTEGER);
      while (rowOffset < rows.length && results.length < limit) {
        const row = rows[rowOffset];
        const part = textPage(row.text, column, 4000);
        const entry = {
          ...row,
          text: part.text,
          text_offset: column,
          text_complete: part.complete,
        };
        if (results.length && bytes([...results, entry]) > 7000) break;
        results.push(entry);
        if (part.next_offset !== null) {
          column = part.next_offset;
          break;
        }
        rowOffset++;
        column = 0;
      }
      const next =
        rowOffset < rows.length
          ? {
              type: "read_file_diff",
              path: file.path,
              revision: file.revision,
              offset: rowOffset,
              text_offset: column,
            }
          : null;
      return {
        path: file.path,
        revision: file.revision,
        previous_revision: file.revision - 1,
        results,
        next,
        next_offset: next?.offset ?? null,
      };
    }

    if (a.type === "list_executions" || a.type === "search_executions")
      return this.executions(a, a.type === "search_executions");
    if (a.type === "read_execution") {
      const row = this.store.get(
        "SELECT record FROM executions WHERE id=?",
        a.execution_id,
      );
      if (!row) throw new AppError("Execution not found", 404);
      const { stdout, stderr, ...record } = JSON.parse(row.record),
        stream = a.stream ?? "stdout";
      if (!["stdout", "stderr"].includes(stream))
        throw new AppError("stream must be stdout or stderr");
      const artifact_id = record[stream + "_artifact_id"];
      if (artifact_id) {
        const part = this.store.artifacts.read(artifact_id, actor, a);
        return { ...record, ...part, stream, output: part.text };
      }
      const output = stream === "stdout" ? stdout || "" : stderr || "",
        offset = integer(a.offset, 0, 0, output.length),
        limit = integer(a.limit, 6000, 1, 8000);
      return {
        ...record,
        stream,
        output: output.slice(offset, offset + limit),
        offset,
        total_characters: output.length,
        next_offset: offset + limit < output.length ? offset + limit : null,
      };
    }
  }
  receipts(result) {
    if (result?.messages)
      return result.messages
        .filter((m) => !m.body_truncated)
        .map((m) => ({ chat_id: m.chat_id, message_id: m.id }));
    if (
      result?.chat_id &&
      Number.isInteger(result.id) &&
      typeof result.body === "string" &&
      !result.body_truncated
    )
      return [{ chat_id: result.chat_id, message_id: result.id }];
    return [];
  }
  overview(actor) {
    return {
      agents: this.execute(actor, { type: "list_agents" }),
      chats: this.chatList(actor),
      coding: this.workspace
        ? {
            files: this.execute(actor, { type: "list_files" }),
            environment: this.workspace.environment(),
            executions: this.executions({ limit: 3 }),
          }
        : null,
    };
  }
}
