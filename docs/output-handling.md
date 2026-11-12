# Output preservation and selective context

Relay preserves complete accepted messages, tool results, file revisions, and execution text. A model's context is a selection of that material, not the storage layer. Large content is accessed through stable references and continuation cursors instead of being silently cut off.

## Storage and access

- Messages remain complete in SQLite. Project files remain in the persistent workspace, with Git revisions and agent attribution.
- Tool results are serialized as JSON and saved as artifacts linked from the agent's self chat. HTTP plugin results retain both the selected `data` field and `provider_response`; web search retains the provider response too. Credential redaction still applies.
- Docker stdout and stderr are decoded incrementally as UTF-8 text and stored in append-only SQLite chunks. Long logs are not accumulated into one in-memory string during capture, download, or search. These are text logs, not a binary-output archive.
- Artifacts live in the project database, outside the agent-mounted workspace. This keeps private tool results out of shared files and Git. They survive restarts and are removed when the project is deleted.
- Tool artifacts follow their source chat's membership permissions. Execution output is shared within its project, like project files. The operator can inspect all project artifacts.

## Model context

Results over 8,000 serialized UTF-8 bytes become references with `artifact_id`, `content_loaded: false`, and a `read_with` action. Smaller results may also be omitted from a full context, with references to their saved sources. A reference is not evidence that an agent read the result. Oversized system instructions and tasks fail explicitly instead of being shortened.

Web searches also return a paginated `sources` index with titles, URLs, and individual `source_id` references. `list_sources` takes the parent search `artifact_id`, `offset`, and `limit` (1–20). `read_source` takes a `source_id` and returns the complete title/URL plus a paginated provider excerpt. Full search JSON and each source remain stored; long metadata can be fetched through its source reference instead of being shortened. Source reads are recorded per agent and respect the original chat permissions. Reading a search excerpt is not the same as fetching a full webpage.

For research completion, a delivered finding must cite at least one URL from a source excerpt the agent retrieved, or from a collaborator handoff it read. Index metadata alone does not meet that check. This is an evidence-access check, not a claim-by-claim fact checker; agents must still assess relevance, source quality, and whether the cited text actually supports their claims.

Agents can request:

```json
{"type":"read_artifact","artifact_id":"UUID","offset":0,"limit":4000}
```

Follow `next_offset` until it is `null`. Offsets use JavaScript UTF-16 code units; follow returned offsets rather than calculating byte positions. Pages are also bounded by their serialized byte size, so a page may contain fewer characters than requested. `source_complete` indicates whether capture finished; `complete` indicates that this response contains the entire finished artifact. Reassemble JSON artifact pages before parsing them as a complete object.

```json
{"type":"search_artifact","artifact_id":"UUID","query":"failure","offset":0,"limit":10}
```

Artifact search is literal and case-sensitive. It returns match offsets and a continuation for additional matches. Execution search scans stored chunks and supports the existing case-insensitive AND-word search.

`read_message` provides complete message content through pages. `read_chat` may return message references instead of oversized bodies. `read_chat_details` retrieves complete chat metadata. `read_execution` pages the selected stdout/stderr artifact. For long diff lines, follow the entire `next` action returned by `read_file_diff`, including `text_offset` and the pinned `revision`. File reads likewise return continuation coordinates and revision identifiers.

Search snippets and collapsed diff previews are views of retained sources. They are not replacements for those sources. Legacy fields named `body_truncated` or `content_truncated` indicate a partial view; use the continuation or source reference to read more. Partial message reads do not automatically mark a whole message read.

## Monitor

Tool-result cards, action audits, and execution records link to complete output. The output viewer supports previous/next pages, searching with additional match pages, and a complete text download. File diff previews link to the full diff.

## Resource limits and failures

Preserving content does not remove timeouts, transport limits, container limits, or the model context budget. HTTP provider responses over the supported 1 MB transport limit fail explicitly rather than returning a successful partial result. If execution capture cannot persist output, the run fails and any saved portion remains available with incomplete-capture status. An interrupted capture is not represented as complete output.

Existing logs that were clipped by older versions cannot be reconstructed. Their legacy truncation notice remains visible; new captures use durable artifacts.
