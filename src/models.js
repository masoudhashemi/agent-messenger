import { randomUUID } from "node:crypto";
import { AppError } from "./store.js";
import { envCredential, modelConfig } from "./model-config.js";

const fields = [
  "id",
  "label",
  "name",
  "api_base",
  "api_key_env",
  "output_mode",
  "token_parameter",
  "max_tokens",
  "context_window_tokens",
  "timeout_seconds",
  "temperature",
  "extra_body",
];
export function publicModel(config) {
  return Object.fromEntries(
    fields.filter((k) => config[k] !== undefined).map((k) => [k, config[k]]),
  );
}
export function validateModel(input) {
  const c = {
    label: input.name,
    api_key_env: "",
    output_mode: "json_schema",
    token_parameter: "max_tokens",
    max_tokens: 4096,
    context_window_tokens: 65536,
    timeout_seconds: 120,
    temperature: 0,
    extra_body: {},
    ...publicModel(input),
  };
  for (const key of ["label", "name", "api_base"])
    if (typeof c[key] !== "string" || !c[key].trim())
      throw new AppError(key + " is required");
  let url;
  try {
    url = new URL(c.api_base);
  } catch {
    throw new AppError("Invalid model endpoint URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError(
      "Use an HTTP(S) API base URL without embedded credentials, query or fragment",
    );
  c.api_base = url.href.replace(/\/$/, "");
  if (!["json_schema", "json_object", "text"].includes(c.output_mode))
    throw new AppError("Invalid output mode");
  if (!["max_tokens", "max_completion_tokens"].includes(c.token_parameter))
    throw new AppError("Invalid output token parameter");
  if (
    typeof c.api_key_env !== "string" ||
    (c.api_key_env && !/^[A-Za-z_][A-Za-z_0-9]*$/.test(c.api_key_env))
  )
    throw new AppError("Invalid API key environment variable");
  for (const [key, min, max] of [
    ["max_tokens", 128, 262144],
    ["context_window_tokens", 2048, 2000000],
    ["timeout_seconds", 1, 600],
  ])
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max)
      throw new AppError(key + " is outside its supported range");
  if (c.max_tokens >= c.context_window_tokens)
    throw new AppError("Output budget must be smaller than the context window");
  if (
    c.temperature !== null &&
    (typeof c.temperature !== "number" ||
      !Number.isFinite(c.temperature) ||
      c.temperature < 0 ||
      c.temperature > 2)
  )
    throw new AppError("Temperature must be 0–2 or null to omit");
  if (
    !c.extra_body ||
    typeof c.extra_body !== "object" ||
    Array.isArray(c.extra_body)
  )
    throw new AppError("Extra body must be a JSON object");
  const reserved = new Set([
    "model",
    "messages",
    "stream",
    "response_format",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "api_key",
    "authorization",
    "headers",
  ]);
  if (Object.keys(c.extra_body).some((k) => reserved.has(k)))
    throw new AppError(
      "Extra body cannot override model, messages, output controls or credentials",
    );
  return c;
}
export class ModelRegistry {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS model_connections(id TEXT PRIMARY KEY,config TEXT NOT NULL,credential TEXT NOT NULL DEFAULT '')",
    );
  }
  list() {
    return this.db
      .prepare("SELECT * FROM model_connections ORDER BY rowid")
      .all()
      .map((r) => ({
        ...JSON.parse(r.config),
        has_credential: !!r.credential,
      }));
  }
  describe(id) {
    if (
      id !== null &&
      id !== undefined &&
      (typeof id !== "string" || !id.trim())
    )
      throw new AppError(
        "Model connection ID must be a nonempty string or null for the local default",
      );
    if (!id) {
      try {
        return {
          ...publicModel(modelConfig()),
          id: null,
          label: "Local default",
        };
      } catch {
        return { id: null, label: "Local default (not configured)" };
      }
    }
    const row = this.db
      .prepare("SELECT config,credential FROM model_connections WHERE id=?")
      .get(id);
    if (!row) throw new AppError("Model connection not found", 404);
    return { ...JSON.parse(row.config), has_credential: !!row.credential };
  }
  save(input) {
    if (input.id !== undefined && (typeof input.id !== "string" || !input.id))
      throw new AppError("Invalid model connection ID");
    const old = input.id
      ? this.db
          .prepare("SELECT * FROM model_connections WHERE id=?")
          .get(input.id)
      : null;
    if (input.id && !old) throw new AppError("Model connection not found", 404);
    const c = validateModel({ ...(old && JSON.parse(old.config)), ...input });
    c.id = old?.id || randomUUID();
    if (input.credential !== undefined && typeof input.credential !== "string")
      throw new AppError("API key must be text");
    // Omitted means preserve; empty string explicitly clears the saved credential.
    const credential =
      input.credential === undefined ? old?.credential || "" : input.credential;
    this.db
      .prepare(
        "INSERT INTO model_connections VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,credential=excluded.credential",
      )
      .run(c.id, JSON.stringify(c), credential);
    return this.describe(c.id);
  }
  resolve(id) {
    if (
      id !== null &&
      id !== undefined &&
      (typeof id !== "string" || !id.trim())
    )
      throw new AppError(
        "Model connection ID must be a nonempty string or null for the local default",
      );
    if (!id) return validateResolved(modelConfig());
    const c = this.describe(id);
    const row = this.db
      .prepare("SELECT credential FROM model_connections WHERE id=?")
      .get(id);
    const token = row.credential || envCredential(c.api_key_env);
    if (c.api_key_env && !token)
      throw new AppError("Missing model API key for " + c.api_key_env);
    return { ...validateModel(c), token };
  }
}
function validateResolved(c) {
  return { ...validateModel(c), token: c.token };
}

export async function requestCompletion(
  config,
  messages,
  schema,
  signal,
  fetcher = fetch,
) {
  const c = validateModel(config);
  const body = {
    ...c.extra_body,
    model: c.name,
    messages,
    [c.token_parameter]: c.max_tokens,
  };
  if (c.temperature !== null) body.temperature = c.temperature;
  if (c.output_mode === "json_schema")
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "agent_turn", schema },
    };
  if (c.output_mode === "json_object")
    body.response_format = { type: "json_object" };
  let response;
  try {
    response = await fetcher(c.api_base + "/chat/completions", {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(config.token ? { Authorization: "Bearer " + config.token } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(c.timeout_seconds * 1000),
      ]),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new AppError(
      e.name === "TimeoutError"
        ? "Model request timed out after " + c.timeout_seconds + " seconds"
        : "Could not reach the model endpoint; check its URL and availability",
    );
  }
  const raw = await response.text();
  const safe = config.token ? raw.split(config.token).join("[REDACTED]") : raw;
  const fail = (message) => {
    const e = new AppError(message);
    e.responseBody = safe;
    throw e;
  };
  if (!response.ok)
    fail(
      "Model endpoint returned HTTP " +
        response.status +
        ". Check the connection, model name and output mode.",
    );
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail("Model endpoint returned a non-JSON HTTP response");
  }
  const choice = data.choices?.[0];
  if (choice?.finish_reason === "length")
    fail(
      "Model hit its output token limit. Increase the connection's output budget; partial actions were not executed.",
    );
  if (choice?.message?.refusal || choice?.finish_reason === "content_filter")
    fail("Model declined the request; no actions were executed.");
  if (
    typeof choice?.message?.content !== "string" ||
    !choice.message.content.trim()
  )
    fail(
      "Model returned no response text; check its output budget and reasoning settings.",
    );
  return choice.message.content;
}
