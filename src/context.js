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
    you: { id: actor, name: agent.name },
    task,
    context: { agents: [], chats: [], active_chat: null, working_thread: null },
    incoming_requests: [],
    coding: retrieval.workspace
      ? {
          files: [],
          environment: retrieval.workspace.environment(),
          recent_executions: [],
          sandbox: "Docker Python, no network, 256 MB, 1 CPU, timeout <= 60s",
        }
      : null,
    previous_action_results: [],
    turn,
    turn_limit: turnLimit,
    context_policy: {
      budget_bytes: budget,
      history:
        "Selective retrieval. Directories and search snippets do not mark messages read. Fetch truncated content using source IDs and pagination. Summaries are hints; verify original sources.",
    },
  };
  const size = () => Buffer.byteLength(system) + bytes(payload) + 256;
  if (size() > budget - 1200)
    throw new AppError(
      "System prompt and task exceed the context budget. Shorten them or increase CONTEXT_MAX_BYTES.",
    );
  const push = (array, item) => {
    array.push(item);
    if (size() > budget) {
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
    const preview = {
      ...message,
      body: message.body.slice(0, 3000),
      body_truncated: message.body.length > 3000,
    };
    if (!push(payload.incoming_requests, preview)) {
      if (
        !push(payload.incoming_requests, {
          id: message.id,
          chat_id: message.chat_id,
          body_truncated: true,
          read_with: "read_message",
        })
      )
        break;
    } else if (!preview.body_truncated)
      receipts.push({ chat_id: message.chat_id, message_id: message.id });
    included.push(message.id);
  }
  const results = Array.isArray(feedback) ? feedback : feedback.results || [];
  for (const result of results) {
    if (push(payload.previous_action_results, result))
      receipts.push(...retrieval.receipts(result));
    else
      push(payload.previous_action_results, {
        truncated: true,
        source: feedback.source || null,
        path: result?.path,
        chat_id: result?.chat_id,
        id: result?.id,
        notice:
          "Result omitted to keep context within budget. Read the saved action-result messages or fetch a smaller page.",
      });
  }
  const directory = retrieval.chatList(actor, { limit: 25 });
  const focus = store.get("SELECT * FROM agent_focus WHERE agent_id=?", actor);
  let activeId = payload.incoming_requests[0]?.chat_id;
  if (!activeId)
    activeId =
      focus?.chat_id ||
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
      loaded = {
        id: chat.id,
        name: chat.name,
        kind: chat.kind,
        summary: chat.summary,
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
    for (const m of rows) {
      if (payload.incoming_requests.some((r) => r.id === m.id)) continue;
      const limited = {
        ...m,
        body: m.body.slice(0, 2000),
        body_truncated: m.body.length > 2000,
      };
      if (!push(loaded.messages, limited)) break;
      if (!limited.body_truncated)
        receipts.push({ chat_id: id, message_id: m.id });
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
      summary: c.summary.slice(0, 180),
      summary_truncated: c.summary.length > 180,
      unread_count: c.unread_count,
      last_read_id: c.last_read_id,
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
