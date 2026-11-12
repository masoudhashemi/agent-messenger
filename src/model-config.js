import { readFileSync, existsSync } from "node:fs";
import { AppError } from "./store.js";

// Values are read at run start. Local credential files are never sent to agents.
export function envCredential(name) {
  if (!name) return "";
  if (process.env[name]) return process.env[name];
  const path = process.env.TOKEN_ENV_FILE || ".env";
  if (!existsSync(path)) return "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)\s*$/,
    );
    if (m && m[1] === name) return m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return "";
}
export function modelConfig() {
  const path = process.env.MODEL_CONFIG || "configs/model.toml";
  if (!existsSync(path))
    throw new AppError(
      "Add a model connection in Models, or create configs/model.toml from configs/model.example.toml.",
    );
  const config = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([\w]+)\s*=\s*(?:"([^"]*)"|([\d.]+))/);
    if (m) config[m[1]] = m[2] ?? Number(m[3]);
  }
  const token = envCredential(config.api_key_env);
  if (config.api_key_env && !token)
    throw new AppError(
      "Model API key is missing; configure its environment variable in the local .env file.",
    );
  return { ...config, token, name: config.name };
}
