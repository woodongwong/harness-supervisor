// The handoff data model is harness-neutral. This registry lists integrations
// actually implemented here; adding a name alone does not implement an adapter.
export const HARNESS_INTEGRATIONS = Object.freeze({
  codex: { displayName: "Codex", stopAfterTool: true },
  zcode: { displayName: "ZCode", stopAfterTool: false },
  codebuddy: { displayName: "CodeBuddy CLI", stopAfterTool: false },
});

// CodeBuddy command hooks use generation_id for the user turn, and expose
// call_id/tool_use_id for tools (verified with CLI 2.150.0). Do not synthesize
// identities from commands: identical parallel calls must remain distinct.
export function normalizeHookInput(harness, input) {
  if (harness === "zcode") return { ...input,
    hook_event_name: input.hook_event_name ?? input.hookEventName,
    session_id: input.session_id ?? input.sessionId,
    turn_id: input.turn_id ?? input.turnId,
    tool_use_id: input.tool_use_id ?? input.toolCallId ?? input.toolUseId,
    tool_name: input.tool_name ?? input.toolName,
    tool_input: input.tool_input ?? input.toolInput,
    tool_response: input.tool_response ?? input.toolResponse,
    last_assistant_message: input.last_assistant_message ?? input.responseText ?? input.responsePreview,
  };
  if (harness !== "codebuddy") return input;
  const normalized = { ...input, turn_id: input.turn_id ?? input.generation_id,
    tool_use_id: input.tool_use_id ?? input.call_id };
  const hook = input.hook_event_name;
  if (["UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop"].includes(hook)
    && (typeof normalized.turn_id !== "string" || !normalized.turn_id)) {
    throw new Error("CodeBuddy Hook 缺少 generation_id，无法安全关联轮次；请检查 CLI 版本");
  }
  return normalized;
}
