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
