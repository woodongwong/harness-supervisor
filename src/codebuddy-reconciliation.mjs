import fs from "node:fs/promises";

const rejection = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

// Compatibility fallback for CodeBuddy 2.150.0's interactive user-cancel path:
// it writes an incomplete/skipRun result but can omit both PostToolUse and Stop.
// This is NOT a general incomplete-result or elapsed-time unlock rule.
export function cancelledCodeBuddyTools(state, events, rows) {
  const owner = state.owner;
  if (owner?.harness !== "codebuddy" || !owner.turnId) return [];
  const matching = rows.filter(r => r.sessionId === owner.sessionId && r.cwd === state.cwd
    && r.providerData?.conversationRequestId === owner.turnId);
  return Object.entries(state.tools).flatMap(([id, tool]) => {
    if (tool.key !== owner.key || tool.turnId !== owner.turnId) return [];
    const pre = events.findLast(e => e.source === "codebuddy-hook" && e.payload?.session_id === owner.sessionId
      && e.payload?.turn_id === owner.turnId && e.payload?.tool_use_id === id && e.payload?.hook_event_name === "PreToolUse");
    if (!pre) return [];
    const calls = matching.filter(r => r.type === "function_call" && r.callId === id && r.name === pre.payload.tool_name);
    const results = matching.filter(r => r.type === "function_call_result" && r.callId === id && r.name === pre.payload.tool_name);
    if (calls.length !== 1 || results.length !== 1) return [];
    const call = calls[0], result = results[0];
    let args;
    try { args = JSON.parse(call.arguments); } catch { return []; }
    // Exact command/file arguments are additional evidence, never a substitute
    // for call ID. Redacted, truncated, or changed arguments fail closed.
    if (JSON.stringify(args) !== JSON.stringify(pre.payload.tool_input)
      || result.status !== "incomplete" || result.providerData?.skipRun !== true
      || result.providerData?.error !== "No (tell CodeBuddy what to do differently)"
      || result.output?.type !== "text" || result.output.text?.trim() !== rejection
      || !(call.timestamp <= Date.parse(pre.at) && Date.parse(pre.at) <= result.timestamp)) return [];
    return [{ id, at: new Date(result.timestamp).toISOString(), reason: "codebuddy_user_cancelled_before_execution",
      outcome: "not_started", evidenceId: result.id }];
  });
}

export async function readCodeBuddyCancellations(state, events) {
  if (state.owner?.harness !== "codebuddy") return [];
  const paths = new Set(events.filter(e => e.source === "codebuddy-hook" && e.payload?.session_id === state.owner.sessionId
    && e.payload?.turn_id === state.owner.turnId && state.tools[e.payload?.tool_use_id])
    .map(e => e.payload.transcript_path).filter(p => typeof p === "string"));
  const resolved = new Map();
  for (const file of paths) {
    let handle;
    try {
      handle = await fs.open(file, "r");
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
      const offset = size - buffer.length;
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (offset) lines.shift();
      const rows = lines.filter(l => l.trim()).map(JSON.parse);
      for (const item of cancelledCodeBuddyTools(state, events, rows)) resolved.set(item.id, item);
    } catch { /* Missing or unfamiliar native evidence preserves the lock. */ }
    finally { await handle?.close(); }
  }
  return [...resolved.values()];
}
