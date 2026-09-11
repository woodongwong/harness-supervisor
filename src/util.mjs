import crypto from "node:crypto";

export const nowIso = () => new Date().toISOString();

export function newTaskId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `task-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

export function truncate(text, limit = 120_000) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

export function classifyFailure(text, exitCode = null) {
  const value = String(text ?? "").toLowerCase();
  if (/usage limit|quota|rate limit|too many requests|exhausted|token limit|credits? exhausted/.test(value)) return "quota";
  if (/authentication|unauthorized|forbidden|login required|not authenticated|invalid.*token|invalid.*api key|\b401\b|\b403\b/.test(value)) return "auth";
  if (/timeout|timed out|connection reset|connection refused|temporar|service unavailable|\b502\b|\b503\b|\b504\b/.test(value)) return "transport";
  if (exitCode === 127 || /enoent|not found|no such file/.test(value)) return "binary_missing";
  if (exitCode && exitCode !== 0) return "process";
  return null;
}

export function parseJsonArrayEnv(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return [...fallback];
  const value = JSON.parse(raw);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  return value;
}

export function renderArgs(template, values) {
  return template.map((item) => item.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(values[key] ?? "")));
}
