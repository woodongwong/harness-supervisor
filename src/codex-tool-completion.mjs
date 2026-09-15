import { fileURLToPath } from "node:url";
import path from "node:path";
import { transcriptTail } from "./tool-reconciliation.mjs";

function nativeCwd(value) {
  if (typeof value !== "string") return null;
  try { return value.startsWith("file:") ? fileURLToPath(value) : value; } catch { return null; }
}

// Native item receipts carry the actual hook call ID, unlike free-form script
// output. Require a terminal status AND exit code; a yielded process ID or a
// completed model turn says nothing about completion of a shell command.
export function completedCodexTools(state, events, rows) {
  const owner = state.owner;
  if (owner?.harness !== "codex" || !owner.turnId || rows[0]?.type !== "session_meta"
    || rows[0].payload?.id !== owner.sessionId) return [];
  const receipts = new Map();
  let contextMatches = false;
  for (const row of rows) {
    if (row.type === "turn_context") contextMatches = row.payload?.turn_id === owner.turnId && row.payload?.cwd === state.cwd;
    const p = row.payload;
    if (!contextMatches || row.type !== "event_msg" || p?.type !== "item_completed"
      || p.thread_id !== owner.sessionId || p.turn_id !== owner.turnId || !p.item?.id) continue;
    const list = receipts.get(p.item.id) ?? [];
    list.push(row);
    receipts.set(p.item.id, list);
  }
  return Object.entries(state.tools).flatMap(([id, tool]) => {
    if (tool.key !== owner.key || tool.turnId !== owner.turnId) return [];
    const pres = events.filter(e => e.source === "codex-hook" && e.payload?.session_id === owner.sessionId
      && e.payload?.turn_id === owner.turnId && e.payload?.hook_event_name === "PreToolUse"
      && (e.payload.tool_use_id ?? e.payload.toolUseId) === id);
    const matches = receipts.get(id) ?? [];
    if (pres.length !== 1 || matches.length !== 1) return [];
    const pre = pres[0], receipt = matches[0], item = receipt.payload.item;
    if (pre.payload.tool_name !== "Bash" || item.type !== "CommandExecution"
      || !["completed", "failed"].includes(item.status) || !Number.isInteger(item.exit_code)
      || !path.isAbsolute(nativeCwd(item.cwd) ?? "")
      || (pre.payload.tool_input?.workdir !== undefined && nativeCwd(item.cwd) !== pre.payload.tool_input.workdir)
      || !Array.isArray(item.command) || item.command.length !== 3
      || !["-c", "-lc"].includes(item.command[1]) || typeof pre.payload.tool_input?.command !== "string"
      || item.command[2] !== pre.payload.tool_input.command
      || !(Date.parse(owner.startAt) <= Date.parse(pre.at) && Date.parse(pre.at) <= Date.parse(receipt.timestamp))) return [];
    return [{ id, at: receipt.timestamp, reason: "codex_native_command_completed", outcome: "returned", exitCode: item.exit_code }];
  });
}

export async function readCodexToolCompletions(state, events) {
  const owner = state.owner;
  if (owner?.harness !== "codex" || !Object.keys(state.tools).length) return [];
  const paths = new Set(events.filter(e => e.source === "codex-hook" && e.payload?.session_id === owner.sessionId
    && e.payload?.turn_id === owner.turnId && e.payload?.hook_event_name === "PreToolUse"
    && state.tools[e.payload.tool_use_id ?? e.payload.toolUseId])
    .map(e => e.payload.transcript_path).filter(p => typeof p === "string"));
  const resolved = new Map();
  for (const file of paths) {
    try {
      const matching = events.filter(e => e.payload?.hook_event_name !== "PreToolUse" || e.payload.transcript_path === file);
      let tools = completedCodexTools(state, matching, await transcriptTail(file));
      // TUI output can push the owning turn context beyond the ordinary tail.
      // Retry a bounded larger window, retaining the exact native identities.
      if (!tools.length) tools = completedCodexTools(state, matching, await transcriptTail(file, { maxBytes: 16 * 1024 * 1024 }));
      for (const tool of tools) resolved.set(tool.id, { ...tool, sourcePath: file });
    } catch { /* Incomplete or changed native evidence cannot release a tool. */ }
  }
  return [...resolved.values()];
}
