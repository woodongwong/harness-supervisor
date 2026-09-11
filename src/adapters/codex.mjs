import { spawn as nodeSpawn } from "node:child_process";

import { classifyFailure, parseJsonArrayEnv, truncate } from "../util.mjs";

export class CodexAdapter {
  constructor({ binary = process.env.CODEX_BIN ?? "codex", extraArgs = null, spawnImpl = nodeSpawn } = {}) {
    this.name = "codex";
    this.binary = binary;
    this.extraArgs = extraArgs ?? parseJsonArrayEnv("CODEX_SUPERVISOR_ARGS_JSON", []);
    this.spawnImpl = spawnImpl;
  }

  capabilities() {
    return {
      harness: this.name,
      headless: true,
      structuredEvents: true,
      resumeSession: true,
      nativeSessionId: true,
      hooks: false,
    };
  }

  async run({ task, prompt, resumeSessionId = null, onEvent = async () => {} }) {
    const args = resumeSessionId
      ? ["exec", "--json", ...this.extraArgs, "resume", resumeSessionId, prompt]
      : ["exec", "--json", ...this.extraArgs, prompt];

    return await runChild({
      binary: this.binary,
      args,
      cwd: task.cwd,
      env: process.env,
      spawnImpl: this.spawnImpl,
      parseJsonLines: true,
      onNativeEvent: async (event) => onEvent({ type: "worker.native", harness: "codex", payload: event }),
    });
  }
}

export async function runChild({ binary, args, cwd, env, spawnImpl, parseJsonLines, onNativeEvent }) {
  let child;
  try {
    child = spawnImpl(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return {
      exitCode: 127,
      signal: null,
      sessionId: null,
      output: "",
      stderr: String(error),
      reason: "binary_missing",
    };
  }

  let stdout = "";
  let stderr = "";
  let buffer = "";
  let sessionId = null;
  const errors = [];
  const agentMessages = [];

  const consumeLine = async (line) => {
    if (!line.trim()) return;
    if (!parseJsonLines) {
      await onNativeEvent({ type: "stdout", text: truncate(line, 50_000) });
      return;
    }
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) sessionId = event.thread_id;
      if (event.type === "turn.failed") errors.push(event?.error?.message ?? JSON.stringify(event));
      if (event.type === "error") errors.push(event.message ?? JSON.stringify(event));
      if (event.type === "item.completed" && event?.item?.type === "agent_message") {
        agentMessages.push(String(event.item.text ?? ""));
      }
      await onNativeEvent(event);
    } catch {
      await onNativeEvent({ type: "stdout.unparsed", text: truncate(line, 50_000) });
    }
  };

  child.stdout?.setEncoding?.("utf8");
  child.stderr?.setEncoding?.("utf8");
  child.stdout?.on?.("data", (chunk) => {
    stdout += String(chunk);
    if (stdout.length > 500_000) stdout = stdout.slice(-500_000);
    buffer += String(chunk);
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      void consumeLine(line);
    }
  });
  child.stderr?.on?.("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 300_000) stderr = stderr.slice(-300_000);
  });

  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.once?.("error", (error) => finish({ code: 127, signal: null, spawnError: error }));
    child.once?.("exit", (code, signal) => finish({ code: code ?? 1, signal, spawnError: null }));
  });

  if (buffer.trim()) await consumeLine(buffer);
  const combined = [stderr, ...errors, result.spawnError?.message].filter(Boolean).join("\n");

  return {
    exitCode: result.code,
    signal: result.signal,
    sessionId,
    output: agentMessages.at(-1) ?? truncate(stdout, 120_000),
    stderr: truncate(stderr, 120_000),
    reason: classifyFailure(combined, result.code),
    command: [binary, ...args],
  };
}
