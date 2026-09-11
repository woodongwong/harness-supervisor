import fs from "node:fs/promises";
import path from "node:path";

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
const sink = process.env.HARNESS_SUPERVISOR_EVENT_SINK
  || path.join(process.env.ZCODE_PLUGIN_DATA || ".", "native-harness-events.jsonl");

try {
  await fs.mkdir(path.dirname(sink), { recursive: true });
  await fs.appendFile(sink, `${JSON.stringify(event)}\n`, "utf8");
  await snapshotTranscript(input, sink);
} catch (error) {
  process.stderr.write(`[harness-supervisor] ${error?.message ?? error}\n`);
}

const hookName = input.hook_event_name ?? input.hookEventName;
if (hookName === "SessionStart" && process.env.HARNESS_SUPERVISOR_CONTEXT_FILE) {
  try {
    const context = await fs.readFile(process.env.HARNESS_SUPERVISOR_CONTEXT_FILE, "utf8");
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context.slice(0, 60_000),
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
