import { AppError } from "./store.js";
import { createHash } from "node:crypto";

export function actionKey(action) {
  const target = Object.fromEntries(
    [
      "chat_id",
      "agent_id",
      "path",
      "message_id",
      "artifact_id",
      "source_id",
      "execution_id",
      "decision_id",
      "stream",
      "query",
    ]
      .filter((key) => action[key] !== undefined)
      .map((key) => [key, action[key]]),
  );
  return (
    action.type +
    ":" +
    createHash("sha256").update(JSON.stringify(target)).digest("hex")
  );
}
export const actionRequired = {
  read_group: ["chat_id"],
  update_group: ["chat_id"],
  record_decision: ["chat_id"],
  send: ["chat_id", "body"],
  reply: ["body"],
  direct: ["agent_id", "body"],
  update_chat: ["chat_id"],
  invite: ["chat_id", "agent_id"],
  focus_chat: ["chat_id"],
  read_chat_details: ["chat_id"],
  read_chat: ["chat_id"],
  read_message: ["message_id"],
  read_artifact: ["artifact_id"],
  search_artifact: ["artifact_id", "query"],
  list_sources: ["artifact_id"],
  read_source: ["source_id"],
  read_file_diff: ["path"],
  read_execution: ["execution_id"],
  web_search: ["query"],
};
export const actionStructuredFields = {
  record_decision: {
    evidence: {
      type: "array",
      items: { anyOf: [{ type: "integer", minimum: 1 }, { type: "string" }] },
    },
    status: { type: "string", enum: ["proposed", "accepted", "rejected"] },
  },
  update_group: {
    status: {
      type: "string",
      enum: ["active", "awaiting_input", "blocked", "resolved"],
    },
    deliverables: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    roles: { type: "object", additionalProperties: { type: "string" } },
    final_message_id: {
      anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
    },
  },
};
function invalid(message) {
  const error = new AppError(message);
  error.validation = true;
  throw error;
}

// Shared by model guidance and runtime validation. Invalid values are rejected,
// never silently clamped (which could hide skipped pages).
export const actionFields = {
  read_group: {
    chat_id: "string",
    offset: [0, Number.MAX_SAFE_INTEGER],
    limit: [1, 30],
  },
  update_group: {
    chat_id: "string",
    purpose: "string",
    owner_id: "string",
    status: "string",
  },
  record_decision: {
    chat_id: "string",
    decision_id: "string",
    title: "string",
    rationale: "string",
    status: "string",
  },
  group: { purpose: "string" },
  send: { chat_id: "string", body: "string" },
  reply: { chat_id: "string", body: "string" },
  direct: { agent_id: "string", body: "string" },
  update_chat: { chat_id: "string" },
  invite: { chat_id: "string", agent_id: "string" },
  focus_chat: { chat_id: "string" },
  read_chat_details: { chat_id: "string" },
  read_chat: {
    chat_id: "string",
    limit: [1, 30],
    after_message_id: [0, Number.MAX_SAFE_INTEGER],
  },
  read_message: {
    message_id: [1, Number.MAX_SAFE_INTEGER],
    offset: [0, Number.MAX_SAFE_INTEGER],
    limit: [1, 64000],
  },
  read_artifact: {
    artifact_id: "string",
    offset: [0, Number.MAX_SAFE_INTEGER],
    limit: [1, 64000],
  },
  search_artifact: {
    artifact_id: "string",
    query: "string",
    offset: [0, Number.MAX_SAFE_INTEGER],
    limit: [1, 30],
  },
  list_sources: {
    artifact_id: "string",
    offset: [0, Number.MAX_SAFE_INTEGER],
    limit: [1, 20],
  },
  read_source: {
    source_id: "string",
    offset: [0, Number.MAX_SAFE_INTEGER],
    limit: [1, 64000],
  },
  read_file_diff: {
    path: "string",
    revision: [1, Number.MAX_SAFE_INTEGER],
    offset: [0, Number.MAX_SAFE_INTEGER],
    text_offset: [0, Number.MAX_SAFE_INTEGER],
    limit: [1, 80],
  },
  read_execution: {
    execution_id: "string",
    offset: [0, Number.MAX_SAFE_INTEGER],
    limit: [1, 8000],
  },
  web_search: { query: "string", limit: [1, 5] },
};
export function validateAction(action) {
  if (!action || typeof action.type !== "string")
    invalid("Every action requires a string type");
  for (const field of actionRequired[action.type] || [])
    if (action[field] === undefined || action[field] === null)
      invalid(
        `${action.type}.${field} is required. Use the exact field name ${field} from the tool example; do not invent an alternative key.`,
      );
  if (
    action.type === "record_decision" &&
    action.evidence !== undefined &&
    (!Array.isArray(action.evidence) ||
      action.evidence.some(
        (ref) => typeof ref !== "string" && (!Number.isInteger(ref) || ref < 1),
      ))
  )
    invalid(
      'record_decision.evidence must contain URLs or integer message IDs, e.g. [123, "https://example.com/source"], not objects',
    );
  for (const [field, rule] of Object.entries(actionFields[action.type] || {})) {
    if (action[field] === undefined) continue;
    const value = action[field];
    if (
      rule === "string"
        ? typeof value !== "string" || !value.trim()
        : !Number.isInteger(value) || value < rule[0] || value > rule[1]
    )
      invalid(
        `${action.type}.${field} must be ${rule === "string" ? "a nonempty string" : `an integer between ${rule[0]} and ${rule[1]}`}. Follow the returned continuation cursor to read more.`,
      );
  }
}
export function auditArguments(value) {
  if (Array.isArray(value)) return value.map(auditArguments);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|password|credential|api.?key|authorization|secret/i.test(key)
          ? "[redacted]"
          : auditArguments(item),
      ]),
    );
  return value;
}
