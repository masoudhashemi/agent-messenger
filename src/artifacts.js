import { randomUUID } from "node:crypto";
import { AppError } from "./store.js";

// Offsets are JavaScript UTF-16 code units. Continuations never split a surrogate pair.
export function textPage(text, offset = 0, limit = 4000) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > text.length ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 64000
  )
    throw new AppError("Invalid page offset or limit");
  let end = Math.min(text.length, offset + limit);
  while (Buffer.byteLength(JSON.stringify(text.slice(offset, end))) > 6000)
    end = offset + Math.max(1, Math.floor((end - offset) / 2));
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[end])
  )
    end += 1;
  return {
    text: text.slice(offset, end),
    offset,
    next_offset: end < text.length ? end : null,
    total_characters: text.length,
    complete: offset === 0 && end === text.length,
  };
}
export class Artifacts {
  constructor(store) {
    this.store = store;
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,owner TEXT,chat_id TEXT,label TEXT NOT NULL,characters INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_chunks(artifact_id TEXT REFERENCES artifacts(id),offset INTEGER,body TEXT NOT NULL,characters INTEGER NOT NULL,PRIMARY KEY(artifact_id,offset));`);
  }
  create({ owner = null, chat_id = null, label = "Output" } = {}) {
    const id = randomUUID();
    this.store.run(
      "INSERT INTO artifacts(id,owner,chat_id,label,created_at) VALUES(?,?,?,?,?)",
      id,
      owner,
      chat_id,
      label,
      new Date().toISOString(),
    );
    return id;
  }
  append(id, text) {
    if (!text) return;
    const row = this.store.get("SELECT * FROM artifacts WHERE id=?", id);
    if (!row || row.complete)
      throw new AppError("Artifact unavailable for append");
    this.store.db.exec("SAVEPOINT artifact_append");
    try {
      for (let offset = 0; offset < text.length;) {
        let end = Math.min(text.length, offset + 16384);
        if (
          end < text.length &&
          /[\uD800-\uDBFF]/.test(text[end - 1]) &&
          /[\uDC00-\uDFFF]/.test(text[end])
        )
          end++;
        const body = text.slice(offset, end);
        this.store.run(
          "INSERT INTO artifact_chunks VALUES(?,?,?,?)",
          id,
          row.characters + offset,
          body,
          body.length,
        );
        offset = end;
      }
      this.store.run(
        "UPDATE artifacts SET characters=characters+? WHERE id=?",
        text.length,
        id,
      );
      this.store.db.exec("RELEASE artifact_append");
    } catch (e) {
      this.store.db.exec(
        "ROLLBACK TO artifact_append; RELEASE artifact_append",
      );
      throw e;
    }
  }
  finish(id) {
    this.store.run("UPDATE artifacts SET complete=1 WHERE id=?", id);
    return id;
  }
  save(text, options) {
    const id = this.create(options);
    this.append(id, text);
    this.finish(id);
    return id;
  }
  info(id, actor = null) {
    if (typeof id !== "string" || !id.trim())
      throw new AppError("artifact_id must be a nonempty string");
    let row = this.store.get("SELECT * FROM artifacts WHERE id=?", id);
    if (!row && /^[0-9a-f]{8}[0-9a-f-]{0,27}$/i.test(id)) {
      const matches = actor
        ? this.store.all(
            "SELECT * FROM artifacts WHERE id LIKE ? AND (owner=? OR owner IS NULL)",
            id.toLowerCase() + "%",
            actor,
          )
        : this.store.all(
            "SELECT * FROM artifacts WHERE id LIKE ?",
            id.toLowerCase() + "%",
          );
      if (matches.length === 1) row = matches[0];
    }
    if (!row) throw new AppError("Artifact not found", 404);
    if (actor) {
      this.store.agent(actor);
      if (row.chat_id) this.store.requireMember(row.chat_id, actor);
      else if (row.owner && row.owner !== actor)
        throw new AppError("Artifact unavailable", 403);
    }
    return row;
  }
  *chunks(id, actor = null) {
    const info = this.info(id, actor);
    for (const row of this.store.db
      .prepare(
        "SELECT body FROM artifact_chunks WHERE artifact_id=? ORDER BY offset",
      )
      .iterate(info.id))
      yield row.body;
  }
  read(id, actor = null, { offset = 0, limit = 4000 } = {}) {
    const info = this.info(id, actor);
    id = info.id;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > info.characters ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 64000
    )
      throw new AppError("Invalid page offset or limit");
    const rows = this.store.all(
      "SELECT * FROM artifact_chunks WHERE artifact_id=? AND offset+characters>? AND offset<? ORDER BY offset",
      id,
      offset,
      offset + limit + 1,
    );
    const text = rows
      .map((r) =>
        r.body.slice(
          Math.max(0, offset - r.offset),
          Math.max(0, offset + limit + 1 - r.offset),
        ),
      )
      .join("");
    const part = textPage(text, 0, limit),
      end = offset + part.text.length;
    return {
      artifact_id: id,
      label: info.label,
      text: part.text,
      offset,
      total_characters: info.characters,
      source_complete: !!info.complete,
      next_offset: end < info.characters ? end : null,
      complete: !!info.complete && offset === 0 && end === info.characters,
    };
  }
  search(id, actor, { query, offset = 0, limit = 10 } = {}) {
    const info = this.info(id, actor);
    id = info.id;
    if (
      typeof query !== "string" ||
      !query ||
      query.length > 1000 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 30
    )
      throw new AppError("Invalid artifact search");
    const hits = [];
    let cursor = offset;
    while (cursor < info.characters) {
      const p = this.read(id, actor, { offset: cursor, limit: 4000 });
      let text = p.text;
      if (p.next_offset !== null)
        text += this.read(id, actor, {
          offset: p.next_offset,
          limit: Math.min(query.length, 1000),
        }).text;
      let index = 0;
      while (
        (index = text.indexOf(query, index)) !== -1 &&
        index < p.text.length
      ) {
        hits.push({
          offset: cursor + index,
          read_with: {
            type: "read_artifact",
            artifact_id: id,
            offset: cursor + index,
          },
        });
        index += Math.max(1, query.length);
        if (hits.length >= limit)
          return {
            artifact_id: id,
            matches: hits,
            next_offset: cursor + index,
          };
      }
      if (p.next_offset === null) break;
      cursor = p.next_offset;
    }
    return { artifact_id: id, matches: hits, next_offset: null };
  }
}
