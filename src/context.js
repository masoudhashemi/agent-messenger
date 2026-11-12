import { AppError } from "./store.js";
import { bytes } from "./retrieval.js";
export const DEFAULT_CONTEXT_BYTES = 64000;
export function buildContext(
  retrieval,
  {
    agent,
    system,
    task,
    incoming = [],
    feedback = [],
    work = null,
    turn,
    turnLimit,
    budget = DEFAULT_CONTEXT_BYTES,
  },
) {
  if (!Number.isInteger(budget) || budget < 16000 || budget > 200000)
    throw new AppError("CONTEXT_MAX_BYTES must be between 16,000 and 200,000");
  const store = retrieval.store,
    actor = agent.id,
    receipts = [],
    included = [];
  const payload = {
    you: { id: actor, name: agent.name, tools: agent.tools || [] },
    task,
    turn_limit: turnLimit,
    context_policy: {
      budget_bytes: budget,
      history:
        "Selective retrieval. Directories and search snippets do not mark messages read. Fetch unloaded content using source IDs and pagination. Summaries are hints; verify original sources.",
    },
    coding: retrieval.workspace
      ? {
          environment: retrieval.workspace.environment(),
          sandbox: "Docker Python, no network, 256 MB, 1 CPU, timeout <= 60s",
          files: [],
          recent_executions: [],
        }
      : null,
    context: {
      agents: [],
      chats: [],
      working_thread: null,
      active_chat: null,
    },
    incoming_requests: [],
    previous_action_results: [],
    work_contract: work,
    turn,
  };
  const size = () => Buffer.byteLength(system) + bytes(payload) + 256;
  if (size() > budget - 1200)
    throw new AppError(
      "System prompt and task exceed the context budget. Shorten them or increase CONTEXT_MAX_BYTES.",
    );
  const push = (array, item, reserve = 2000) => {
    array.push(item);
    if (size() > budget - reserve) {
      array.pop();
      return false;
    }
    return true;
  };
  const set = (object, key, value) => {
    const old = object[key];
    object[key] = value;
    if (size() > budget) {
      object[key] = old;
      return false;
    }
    return true;
  };
  for (const entry of incoming.slice(0, 4)) {
    const message = entry.message ?? entry;
    const full = {
      ...message,
      body: message.body,
      body_truncated: false,
    };
    if (!push(payload.incoming_requests, full)) {
      if (
        !push(payload.incoming_requests, {
          id: message.id,
          chat_id: message.chat_id,
          body_truncated: true,
          read_with: "read_message",
        })
      )
        break;
    } else receipts.push({ chat_id: message.chat_id, message_id: message.id });
    included.push(message.id);
  }
  const results = Array.isArray(feedback) ? feedback : feedback.results || [];
  for (const result of results) {
    if (push(payload.previous_action_results, result))
      receipts.push(...retrieval.receipts(result));
    else {
      const source = result?.artifact_id
        ? { artifact_id: result.artifact_id }
        : feedback.source || null;
      push(
        payload.previous_action_results,
        {
          content_loaded: false,
          source,
          read_with: result?.artifact_id
            ? { type: "read_artifact", artifact_id: result.artifact_id }
            : {
                type: "read_message",
                message_id: feedback.source?.message_ids?.[0],
              },
          path: result?.path,
          chat_id: result?.chat_id,
          id: result?.id,
          notice:
            "Content is saved but not loaded in this turn. Follow read_with and continuation offsets to inspect it.",
        },
        0,
      );
    }
  }

  const directory = retrieval.chatList(actor, { limit: 25 });
  const focus = store.get("SELECT * FROM agent_focus WHERE agent_id=?", actor);
  const focusedEntry = directory.results.find((c) => c.id === focus?.chat_id);
  const newerUnreadDirect = directory.results.find(
    (c) =>
      c.kind === "direct" &&
      c.unread_count > 0 &&
      c.last_message_id > (focusedEntry?.last_message_id || 0),
  );
  const newerUnreadAny = directory.results.find(
    (c) =>
      c.unread_count > 0 &&
      c.last_message_id > (focusedEntry?.last_message_id || 0),
  );
  let activeId = payload.incoming_requests[0]?.chat_id;
  if (!activeId)
    activeId =
      newerUnreadDirect?.id ||
      newerUnreadAny?.id ||
      focus?.chat_id ||
      directory.results.find((c) => c.kind === "direct" && c.unread_count > 0)
        ?.id ||
      directory.results.find((c) => c.unread_count > 0)?.id ||
      directory.results.find((c) => c.kind !== "self")?.id;
  const load = (id, key, notes = false) => {
    if (
      !id ||
      !store.get(
        "SELECT 1 FROM members WHERE chat_id=? AND agent_id=?",
        id,
        actor,
      )
    )
      return;
    const chat = store.chat(id),
      readState = !notes ? store.readState(id, actor) : null,
      loaded = {
        id: chat.id,
        name: chat.name,
        kind: chat.kind,
        ...(notes ? {} : { members: chat.members }),
        ...(bytes(chat.summary) > 4000
          ? {
              metadata_loaded: false,
              read_with: { type: "read_chat_details", chat_id: chat.id },
            }
          : { summary: chat.summary }),
        ...(readState?.first_unread_id !== null &&
        readState?.first_unread_id !== undefined
          ? { first_unread_id: readState.first_unread_id }
          : {}),
        messages: [],
      };
    if (!set(payload.context, key, loaded)) return;
    const rows = notes
      ? store.all(
          "SELECT * FROM (SELECT * FROM messages WHERE chat_id=? AND body LIKE 'Turn % · Working note%' ORDER BY id DESC LIMIT 2) ORDER BY id",
          id,
        )
      : store.all(
          "SELECT * FROM (SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 6) ORDER BY id",
          id,
        );
    let omittedInWindow = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i];
      if (payload.incoming_requests.some((r) => r.id === m.id)) continue;
      const turnPrefix = notes
        ? m.body.match(/^(Turn \d+) · Working note\n/)?.[1]
        : null;
      const resultIds = turnPrefix
        ? store
            .all(
              "SELECT id FROM messages WHERE chat_id=? AND id>? AND id<COALESCE((SELECT MIN(id) FROM messages WHERE chat_id=? AND id>? AND body LIKE 'Turn % · Working note%'),9223372036854775807) AND body LIKE ? ORDER BY id",
              id,
              m.id,
              id,
              m.id,
              `${turnPrefix} · Action results%`,
            )
            .map((r) => r.id)
        : [];
      const complete = {
        ...m,
        body: m.body,
        body_truncated: false,
        ...(resultIds.length ? { result_message_ids: resultIds } : {}),
      };
      loaded.messages.unshift(complete);
      if (size() > budget - 2000) {
        loaded.messages.shift();
        push(loaded.messages, {
          id: m.id,
          chat_id: id,
          sender_id: m.sender_id,
          body_loaded: false,
          body_truncated: true,
          read_with: { type: "read_message", message_id: m.id },
        });
        omittedInWindow = true;
        continue;
      }
      receipts.push({ chat_id: id, message_id: m.id });
    }
    if (!notes && rows.length) {
      const oldestLoadedId = loaded.messages[0]?.id ?? rows.at(-1).id + 1;
      const hasOlder =
        omittedInWindow ||
        !!store.get(
          "SELECT 1 FROM messages WHERE chat_id=? AND id<? LIMIT 1",
          id,
          oldestLoadedId,
        );
      if (hasOlder) set(loaded, "older_messages_available", true);
    }
  };
  load(activeId, "active_chat");
  if (payload.context.active_chat)
    retrieval.focus(actor, payload.context.active_chat.id);
  let selfId = focus?.self_chat_id;
  if (!selfId) selfId = directory.results.find((c) => c.kind === "self")?.id;
  if (selfId !== activeId) load(selfId, "working_thread", true);
  for (const a of retrieval.execute(actor, { type: "list_agents", limit: 30 })
    .results)
    if (!push(payload.context.agents, a)) break;
  for (const c of directory.results) {
    const item = {
      id: c.id,
      name: c.name,
      kind: c.kind,
      members: c.members,
      summary: c.summary,
      summary_truncated: false,
      ...(c.read_with
        ? { metadata_loaded: false, read_with: c.read_with }
        : {}),
      unread_count: c.unread_count,
      last_read_id: c.last_read_id,
      ...(c.first_unread_id !== null && c.first_unread_id !== undefined
        ? { first_unread_id: c.first_unread_id }
        : {}),
      last_message_id: c.last_message_id,
    };
    if (!push(payload.context.chats, item)) break;
  }
  payload.context.directory_more =
    directory.next_offset !== null ||
    payload.context.chats.length < directory.results.length;
  if (payload.coding) {
    for (const f of retrieval.execute(actor, { type: "list_files", limit: 30 })
      .results)
      if (!push(payload.coding.files, f)) break;
    for (const r of retrieval.execute(actor, {
      type: "list_executions",
      limit: 3,
    }).results)
      if (!push(payload.coding.recent_executions, r)) break;
  }
  // Small metadata fields are reserved rather than silently exceeding the cap.
  if (size() > budget) {
    delete payload.context.directory_more;
  }
  return {
    payload,
    receipts,
    included_requests: included,
    usage: {
      bytes: size(),
      budget_bytes: budget,
      loaded_messages: receipts.length,
      listed_chats: payload.context.chats.length,
      active_chat_id: payload.context.active_chat?.id || null,
    },
  };
}
