import { transcriptTail } from "./tool-reconciliation.mjs";

export function completedCodexTurn(state, rows) {
  const owner = state.owner;
  if (owner?.harness !== "codex" || !owner.turnId || rows[0]?.type !== "session_meta"
    || rows[0].payload?.id !== owner.sessionId) return null;
  let contextMatches = false;
  for (const row of rows) {
    if (row.type === "turn_context") contextMatches = row.payload?.turn_id === owner.turnId && row.payload?.cwd === state.cwd;
    if (!contextMatches || row.type !== "event_msg" || row.payload?.type !== "task_complete"
      || row.payload.turn_id !== owner.turnId || !(Date.parse(row.timestamp) >= Date.parse(owner.startAt))) continue;
    return { at: row.timestamp, turnId: owner.turnId, sessionId: owner.sessionId,
      reply: typeof row.payload.last_agent_message === "string" ? row.payload.last_agent_message : "",
      reason: "codex_native_task_complete" };
  }
  return null;
}

export async function readCompletedCodexTurn(state, events) {
  const owner = state.owner;
  if (owner?.harness !== "codex") return null;
  const paths = new Set(events.filter(e => e.source === "codex-hook" && e.payload?.session_id === owner.sessionId
    && e.payload?.turn_id === owner.turnId).map(e => e.payload.transcript_path).filter(p => typeof p === "string"));
  for (const file of paths) {
    try {
      const completion = completedCodexTurn(state, await transcriptTail(file));
      if (completion) return { ...completion, sourcePath: file };
    } catch { /* Unknown, truncated or missing native evidence does not unlock. */ }
  }
  return null;
}
