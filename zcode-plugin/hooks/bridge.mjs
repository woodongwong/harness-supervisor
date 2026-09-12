import fs from "node:fs/promises";
import path from "node:path";
import { resolveBinding } from "./bindings.mjs";
import { relayEnv } from "./runtime-config.mjs";

const MAX_STRING = 80_000;
const MAX_TRANSCRIPT = 1_000_000;

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try {
  input = JSON.parse(raw.trim() || "{}");
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

const payload = redact(input);
const event = { at: new Date().toISOString(), source: "zcode-hook", payload };
let binding = null;
try {
  if (!relayEnv("EVENT_SINK")) binding = await resolveBinding(input);
} catch (error) { process.stderr.write(`[harness-relay] binding: ${error.message}\n`); }
const sink = relayEnv("EVENT_SINK")
  || (binding && path.join(binding.taskDir, "external-events.jsonl"))
  || path.join(process.env.ZCODE_PLUGIN_DATA || ".", "native-harness-events.jsonl");
const contextFile = relayEnv("CONTEXT_FILE")
  || (binding && path.join(binding.taskDir, "context.md"));

try {
  await fs.mkdir(path.dirname(sink), { recursive: true });
  await fs.appendFile(sink, `${JSON.stringify(event)}\n`, "utf8");
  await snapshotTranscript(input, sink);
} catch (error) {
  process.stderr.write(`[harness-relay] ${error?.message ?? error}\n`);
}

const hookName = input.hook_event_name ?? input.hookEventName;
if (hookName === "SessionStart" && contextFile) {
  try {
    const context = await fs.readFile(contextFile, "utf8");
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: boundedContext(context, contextFile),
      },
    }) + "\n");
    process.exit(0);
  } catch {}
}

process.stdout.write("{}\n");

async function snapshotTranscript(value, eventSink) {
  const transcript = value.transcript_path ?? value.transcriptPath;
  const session = value.session_id ?? value.sessionId;
  if (!transcript || !session) return;
  try {
    let text = await fs.readFile(transcript, "utf8");
    if (text.length > MAX_TRANSCRIPT) {
      const tail = text.slice(-MAX_TRANSCRIPT);
      const firstNewline = tail.indexOf("\n");
      text = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
    }
    text = text.split("\n").map((line) => {
      if (!line) return line;
      try { return JSON.stringify(redact(JSON.parse(line))); }
      catch { return redact(line); }
    }).join("\n");
    const dir = path.join(path.dirname(eventSink), "native");
    await fs.mkdir(dir, { recursive: true });
    const safeSession = String(session).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    const target = path.join(dir, `zcode-${safeSession}.jsonl`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, target);
  } catch {}
}

function redact(value, key = "") {
  if (value == null) return value;
  if (typeof value === "string") {
    if (/api.?key|authorization|password|secret|access.?token|refresh.?token/i.test(key)) return "[REDACTED]";
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
      .slice(0, MAX_STRING);
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, key));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 200).map(([k, v]) => [k, redact(v, k)]),
    );
  }
  return value;
}

function boundedContext(context, file) {
  const prefix = `Takeover context file: ${file}\nRead this file for full task details before continuing.\n\n`;
  let excerpt = context.slice(0, 20_000);
  while (Buffer.byteLength(JSON.stringify(prefix + excerpt), "utf8") > 24_000) {
    excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.8));
  }
  return prefix + excerpt;
}
