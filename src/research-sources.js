import { textPage } from "./artifacts.js";
import { AppError } from "./store.js";

export class ResearchSources {
  constructor(store) {
    this.store = store;
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS research_sources(id TEXT PRIMARY KEY,parent_id TEXT,position INTEGER,title TEXT,url TEXT);
      CREATE TABLE IF NOT EXISTS source_reads(agent_id TEXT,source_id TEXT,offset INTEGER,characters INTEGER,created_at TEXT);`);
  }
  save(parent, results, options) {
    for (const [position, source] of results.entries()) {
      const id = this.store.artifacts.save(JSON.stringify(source), {
        ...options,
        label: "Search source",
      });
      this.store.run(
        "INSERT INTO research_sources VALUES(?,?,?,?,?)",
        id,
        parent,
        position,
        source.title,
        source.url,
      );
    }
  }
  list(actor, { artifact_id, offset = 0, limit = 5 }) {
    this.store.artifacts.info(artifact_id, actor);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new AppError(
        "list_sources.offset must be nonnegative; limit must be 1–20",
      );
    const rows = this.store.all(
      "SELECT * FROM research_sources WHERE parent_id=? ORDER BY position LIMIT ? OFFSET ?",
      artifact_id,
      limit + 1,
      offset,
    );
    const results = [];
    for (const row of rows.slice(0, limit)) {
      const item = {
        source_id: row.id,
        title: row.title,
        url: row.url,
        content_loaded: false,
        read_with: { type: "read_source", source_id: row.id },
      };
      if (Buffer.byteLength(JSON.stringify(item)) > 1500) {
        delete item.title;
        delete item.url;
        item.metadata_loaded = false;
      }
      if (
        results.length &&
        Buffer.byteLength(JSON.stringify([...results, item])) > 3500
      )
        break;
      results.push(item);
    }
    return {
      results,
      next_offset:
        rows.length > results.length ? offset + results.length : null,
      artifact_id,
    };
  }
  read(actor, { source_id, offset = 0, limit = 3000 }) {
    this.store.artifacts.info(source_id, actor);
    const row = this.store.get(
      "SELECT * FROM research_sources WHERE id=?",
      source_id,
    );
    if (!row) throw new AppError("Source not found", 404);
    const source = JSON.parse(
      [...this.store.artifacts.chunks(source_id, actor)].join(""),
    );
    const part = textPage(source.snippet || "", offset, limit);
    this.store.run(
      "INSERT INTO source_reads VALUES(?,?,?,?,?)",
      actor,
      source_id,
      offset,
      part.text.length,
      new Date().toISOString(),
    );
    return {
      source_id,
      title: source.title,
      url: source.url,
      ...part,
      note: "Provider search excerpt, not a full-page fetch. Cite this URL only for claims supported by the text read.",
    };
  }
  observedUrls(actor, since) {
    return this.store
      .all(
        "SELECT DISTINCT s.url FROM source_reads r JOIN research_sources s ON s.id=r.source_id WHERE r.agent_id=? AND r.created_at>=? AND r.characters>0",
        actor,
        since,
      )
      .map((r) => r.url);
  }
}
