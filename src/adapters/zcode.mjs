import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs/promises";

import { runChild } from "./codex.mjs";
import { parseJsonArrayEnv, renderArgs, truncate } from "../util.mjs";

export class ZCodeAdapter {
  constructor({ binary = process.env.ZCODE_BIN ?? "zcode", argsTemplate = null, resumeArgsTemplate = null, spawnImpl = nodeSpawn } = {}) {
    this.name = "zcode";
    this.binary = binary;
    this.argsTemplate = argsTemplate ?? parseJsonArrayEnv("ZCODE_SUPERVISOR_ARGS_JSON", ["--prompt", "{prompt}"]);
    this.resumeArgsTemplate = resumeArgsTemplate
      ?? (process.env.ZCODE_SUPERVISOR_RESUME_ARGS_JSON
        ? parseJsonArrayEnv("ZCODE_SUPERVISOR_RESUME_ARGS_JSON")
        : null);
    this.spawnImpl = spawnImpl;
  }

  capabilities() {
    return {
      harness: this.name,
      headless: true,
      structuredEvents: false,
      resumeSession: Boolean(this.resumeArgsTemplate),
      nativeSessionId: true,
      hooks: true,
    };
  }

  async run({ task, prompt, resumeSessionId = null, onEvent = async () => {}, taskDir, contextPath, externalEventsPath }) {
    if (resumeSessionId && !this.resumeArgsTemplate) {
      throw new Error("ZCode resume is not configured. Set ZCODE_SUPERVISOR_RESUME_ARGS_JSON if your launcher exposes resume.");
    }

    const template = resumeSessionId ? this.resumeArgsTemplate : this.argsTemplate;
    const args = renderArgs(template, {
      prompt,
      session: resumeSessionId ?? "",
      cwd: task.cwd,
      task: task.id,
    });
    const env = {
      ...process.env,
      HARNESS_SUPERVISOR_TASK_ID: task.id,
      HARNESS_SUPERVISOR_TASK_DIR: taskDir,
      HARNESS_SUPERVISOR_CONTEXT_FILE: contextPath,
      HARNESS_SUPERVISOR_EVENT_SINK: externalEventsPath,
    };

    const result = await runChild({
      binary: this.binary,
      args,
      cwd: task.cwd,
      env,
      spawnImpl: this.spawnImpl,
      parseJsonLines: false,
      onNativeEvent: async (event) => onEvent({ type: "worker.native", harness: "zcode", payload: event }),
    });

    result.sessionId = result.sessionId ?? await latestSessionId(externalEventsPath);
    result.output = result.output || await latestAssistant(externalEventsPath);
    return result;
  }
}

async function readJsonl(file) {
  try {
    return (await fs.readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; }
        catch { return []; }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function latestSessionId(file) {
  const rows = await readJsonl(file);
  for (let i = rows.length - 1; i >= 0; i--) {
    const id = rows[i]?.payload?.session_id ?? rows[i]?.payload?.sessionId;
    if (id) return String(id);
  }
  return null;
}

async function latestAssistant(file) {
  const rows = await readJsonl(file);
  for (let i = rows.length - 1; i >= 0; i--) {
    const value = rows[i]?.payload?.last_assistant_message ?? rows[i]?.payload?.lastAssistantMessage;
    if (value) return truncate(value, 120_000);
  }
  return "";
}
