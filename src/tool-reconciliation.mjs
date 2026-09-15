// Codex apply_patch is synchronous: it cannot leave a shell/background job
// after the turn's Stop. Validation errors can omit PostToolUse. Do not extend
// this rule to Bash, MCP, interruption, or unknown tool types.
export function stoppedPatchCalls(state, events) {
  const owner = state.owner;
  if (owner?.harness !== "codex" || owner.active || !owner.turnId) return [];
  const matching = events.filter(event => {
    const p = event.payload ?? {};
    return (event.harness ?? String(event.source ?? "").replace(/-hook$/, "")) === "codex"
      && (p.session_id ?? p.sessionId) === owner.sessionId && p.turn_id === owner.turnId;
  });
  const stopped = matching.findLastIndex(event => event.payload.hook_event_name === "Stop");
  if (stopped < 0) return [];
  return Object.entries(state.tools).flatMap(([id, tool]) => {
    if (tool.key !== owner.key || tool.turnId !== owner.turnId) return [];
    const started = matching.findLastIndex(event => event.payload.hook_event_name === "PreToolUse"
      && (event.payload.tool_use_id ?? event.payload.toolUseId) === id);
    if (started < 0 || started >= stopped || matching[started].payload.tool_name !== "apply_patch") return [];
    return [{ id, stopAt: matching[stopped].at, reason: "stopped_synchronous_patch", outcome: "unknown" }];
  });
}

// Native transcripts are a fallback, not a stable API. Accept only a single
// literal exec_command call and its matching pre-process rejection. Never eval
// transcript code, infer completion from Stop, or match command output text.
function literalCommand(input) {
  if (typeof input !== "string") return null;
  const match = input.trim().match(/^const (\w+) = await tools\.exec_command\((\{[\s\S]*\})\);\s*text\(JSON\.stringify\(\1\)\);$/);
  if (!match) return null;
  const body = match[2];
  const pair = /\s*(?:,\s*)?(?:"(\w+)"|(\w+))\s*:\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|true|false|null)\s*/y;
  const values = {};
  let offset = 1;
  while (offset < body.length - 1) {
    pair.lastIndex = offset;
    const field = pair.exec(body);
    if (!field || (offset > 1 && !field[0].trimStart().startsWith(","))) return null;
    const key = field[1] ?? field[2];
    if (!["cmd", "workdir", "yield_time_ms", "max_output_tokens", "login", "tty", "shell"].includes(key)
      || Object.hasOwn(values, key)) return null;
    try { values[key] = JSON.parse(field[3]); } catch { return null; }
    offset = pair.lastIndex;
  }
  return offset === body.length - 1 && typeof values.cmd === "string" ? values.cmd : null;
}

export function rejectedShellCalls(state, events, transcript) {
  const owner = state.owner;
  if (owner?.harness !== "codex" || owner.active || !owner.turnId) return [];
  const meta = transcript[0];
  if (meta?.type !== "session_meta" || meta.payload?.id !== owner.sessionId) return [];
  const matching = events.filter(e => e.source === "codex-hook"
    && e.payload?.session_id === owner.sessionId && e.payload?.turn_id === owner.turnId);
  const stop = matching.findLast(e => e.payload.hook_event_name === "Stop");
  if (!stop) return [];
  const calls = new Map();
  const resolved = [];
  let turn;
  for (const row of transcript) {
    if (row.type === "turn_context") { turn = row.payload?.turn_id; calls.clear(); }
    if (turn !== owner.turnId || row.type !== "response_item") continue;
    const p = row.payload;
    if (p?.type === "custom_tool_call" && p.name === "exec") {
      const command = literalCommand(p.input);
      if (command && p.call_id) calls.set(p.call_id, { command, at: row.timestamp });
    }
    if (p?.type !== "custom_tool_call_output" || !calls.has(p.call_id)) continue;
    const call = calls.get(p.call_id);
    calls.delete(p.call_id);
    if (!Array.isArray(p.output) || p.output.length !== 2
      || p.output.some(block => block.type !== "input_text" || typeof block.text !== "string")
      || !p.output[0].text.startsWith("Script failed\n")
      || !p.output[1].text.startsWith('Script error:\nexec_command failed: CreateProcess { message: "Rejected(')) continue;
    const startMs = Date.parse(call.at), endMs = Date.parse(row.timestamp), stopMs = Date.parse(stop.at);
    if (!(startMs <= endMs && endMs <= stopMs)) continue;
    // A single hook must fall inside this call/output interval. Parallel calls,
    // missing timestamps, truncation, and mismatched commands remain fenced.
    const starts = matching.filter(e => e.payload.hook_event_name === "PreToolUse"
      && Date.parse(e.at) >= startMs && Date.parse(e.at) <= endMs);
    if (starts.length !== 1) continue;
    const pre = starts[0].payload;
    const id = pre.tool_use_id;
    const tool = state.tools[id];
    if (pre.tool_name !== "Bash" || pre.tool_input?.command !== call.command
      || tool?.key !== owner.key || tool.turnId !== owner.turnId) continue;
    resolved.push({ id, stopAt: stop.at, reason: "codex_process_creation_rejected", outcome: "not_started", callId: p.call_id });
  }
  return resolved;
}

export async function transcriptTail(file, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 256 * 1024));
    const first = await handle.read(head, 0, head.length, 0);
    const meta = JSON.parse(head.subarray(0, first.bytesRead).toString("utf8").split("\n")[0]);
    const tail = Buffer.alloc(Math.min(size, maxBytes));
    const offset = size - tail.length;
    const last = await handle.read(tail, 0, tail.length, offset);
    const lines = tail.subarray(0, last.bytesRead).toString("utf8").split("\n");
    if (offset) lines.shift();
    const rows = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line));
    }
    return [meta, ...rows];
  } finally { await handle.close(); }
}

export async function stoppedRejectedShellCalls(state, events) {
  const owner = state.owner;
  if (owner?.harness !== "codex" || owner.active) return [];
  const paths = new Set(events.filter(e => e.source === "codex-hook"
    && e.payload?.session_id === owner.sessionId && e.payload?.turn_id === owner.turnId
    && e.payload?.hook_event_name === "PreToolUse" && e.payload?.tool_name === "Bash"
    && state.tools[e.payload.tool_use_id]).map(e => e.payload.transcript_path).filter(p => typeof p === "string"));
  const resolved = new Map();
  for (const file of paths) {
    try {
      const matching = events.filter(e => e.payload?.hook_event_name !== "PreToolUse" || e.payload.transcript_path === file);
      for (const tool of rejectedShellCalls(state, matching, await transcriptTail(file))) resolved.set(tool.id, tool);
    } catch {
      // Missing, unreadable, oversized metadata or unknown/truncated records
      // provide no evidence. Preserve the reservation for manual inspection.
    }
  }
  return [...resolved.values()];
}
import fs from "node:fs/promises";
