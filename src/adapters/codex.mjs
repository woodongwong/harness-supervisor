import { spawn as nodeSpawn } from "node:child_process";

import { classifyFailure, parseJsonArrayEnv, truncate } from "../util.mjs";

export class CodexAdapter {
  constructor({ binary = process.env.CODEX_BIN ?? "codex", extraArgs = null, spawnImpl = nodeSpawn } = {}) {
    this.name = "codex";
    this.binary = binary;
    this.extraArgs = extraArgs ?? parseJsonArrayEnv("CODEX_RELAY_ARGS_JSON", [], "CODEX_SUPERVISOR_ARGS_JSON");
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

  async run({ task, prompt, resumeSessionId = null, onEvent = async () => {}, signal }) {
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
      signal,
      onNativeEvent: async (event) => onEvent({ type: "worker.native", harness: "codex", payload: event }),
    });
  }
}

export async function runChild({ binary, args, cwd, env, spawnImpl, parseJsonLines, onNativeEvent, signal }) {
  if (signal?.aborted) return { exitCode: 130, reason: "cancelled", output: "", stderr: "Cancelled", sessionId: null };
  let child;
  try {
    child = spawnImpl(binary, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
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
  let pending = Promise.resolve();
  let journalError = null;
  let sawFailedTurn = false;
  let sawCompletedTurn = false;
  let killTimer;
  const kill = (sig) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
      else child.kill?.(sig);
    } catch (error) { if (error.code !== "ESRCH") child.kill?.(sig); }
  };
  const cancel = () => {
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 3000);
    killTimer.unref();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();

  const consumeLine = async (line) => {
    if (!line.trim()) return;
    if (!parseJsonLines) {
      await onNativeEvent({ type: "stdout", text: truncate(line, 50_000) });
      return;
    }
    let event;
    try { event = JSON.parse(line); }
    catch {
      await onNativeEvent({ type: "stdout.unparsed", text: truncate(line, 50_000) });
      return;
    }
    if (event.type === "thread.started" && event.thread_id) sessionId = event.thread_id;
    if (event.type === "turn.completed") sawCompletedTurn = true;
    if (event.type === "turn.failed") {
      sawFailedTurn = true;
      errors.push(event?.error?.message ?? JSON.stringify(event));
    }
    if (event.type === "error") errors.push(event.message ?? JSON.stringify(event));
    if (event.type === "item.completed" && event?.item?.type === "agent_message") {
      agentMessages.push(String(event.item.text ?? ""));
    }
    await onNativeEvent(event);
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
      pending = pending.then(() => consumeLine(line)).catch((error) => {
        journalError ??= error;
        cancel();
      });
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
    child.once?.("close", (code, signal) => finish({ code: code ?? 1, signal, spawnError: null }));
  });

  clearTimeout(killTimer);
  signal?.removeEventListener("abort", cancel);
  await pending;
  if (buffer.trim() && !journalError) {
    try { await consumeLine(buffer); } catch (error) { journalError = error; }
  }
  clearTimeout(killTimer);
  if (journalError) {
    throw Object.assign(new Error(`Event journal failed: ${journalError.message}`), { code: "JOURNAL_FAILED" });
  }
  const combined = [stderr, ...errors, result.spawnError?.message].filter(Boolean).join("\n");

  return {
    exitCode: result.code,
    signal: result.signal,
    sessionId,
    output: agentMessages.at(-1) ?? truncate(stdout, 120_000),
    stderr: truncate(stderr, 120_000),
    reason: signal?.aborted ? "cancelled"
      : result.code === 0 && !sawFailedTurn && (sawCompletedTurn || errors.length === 0) ? null
      : classifyFailure(combined, result.code) ?? "process",
    command: [binary, ...args],
  };
}
