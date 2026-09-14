import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import crypto from "node:crypto";

const short = (value, limit) => String(value ?? "").slice(0, limit);
const toolId = p => p.tool_use_id ?? p.toolUseId;

function observe(state, event) {
  const p = event.payload ?? {};
  const harness = String(event.source ?? "").replace(/-hook$/, "");
  const sessionId = p.session_id ?? p.sessionId;
  const hook = p.hook_event_name ?? p.hookEventName;
  if (!harness || !sessionId) return;
  let turn = state.turns.findLast(t => t.harness === harness && t.sessionId === sessionId
    && (!p.turn_id || t.turnId === p.turn_id));
  if (hook === "UserPromptSubmit") {
    turn = { harness, sessionId, turnId: p.turn_id ?? null, request: short(p.prompt, 1800),
      startAt: event.at, at: event.at, lifecycle: "no_end_observed", tools: [], omittedTools: 0 };
    state.turns.push(turn);
    if (state.turns.length > 6) { state.turns.shift(); state.omittedTurns++; }
    return;
  }
  if (!turn) return; // A truncated legacy journal does not establish a request.
  turn.at = event.at;
  if (["Stop", "Interrupt", "SessionEnd"].includes(hook)) {
    turn.lifecycle = hook;
    if (p.last_assistant_message ?? p.lastAssistantMessage) {
      const reply = String(p.last_assistant_message ?? p.lastAssistantMessage);
      turn.reply = reply.length > 2400 ? `${reply.slice(0, 1600)}…[excerpt]…${reply.slice(-800)}` : reply;
    }
  }
  if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(hook) || !toolId(p)) return;
  let tool = turn.tools.find(t => t.id === toolId(p));
  if (!tool) {
    tool = { id: toolId(p), name: short(p.tool_name ?? p.toolName, 80) };
    turn.tools.push(tool);
    if (turn.tools.length > 16) { turn.tools.shift(); turn.omittedTools++; }
  }
  tool.at = event.at;
  tool.status = hook === "PreToolUse" ? "unconfirmed" : hook === "PostToolUseFailure" ? "failed" : "returned";
  if (p.handoff_content_omitted) { tool.detail = "[handoff material omitted]"; return; }
  const args = p.tool_input ?? p.toolInput ?? {};
  tool.detail = short(args.command ?? args.cmd ?? args.file_path ?? args.filePath ?? args.path ?? tool.detail, 240);
  const response = p.tool_response ?? p.toolResponse;
  const code = response?.exit_code ?? response?.exitCode ?? response?.result?.exit_code;
  if (Number.isInteger(code)) tool.exitCode = code;
  // Keep observations, not inferred test verdicts or full tool bodies/secrets.
  if (hook === "PostToolUseFailure") tool.error = short(p.error?.message ?? p.error, 200);
}

// The journal is authoritative. A byte cursor lets the next hook replay events
// left behind if a process died between append and checkpoint rename.
export async function refreshPassiveCheckpoint(store, id) {
  const file = path.join(store.taskDir(id), "passive.json");
  let state;
  try { state = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  state ??= { version: 1, offset: 0, turns: [], omittedTurns: 0 };
  const journal = store.externalEventsPath(id);
  let size;
  try { size = (await fs.stat(journal)).size; }
  catch (error) { if (error.code === "ENOENT") return state; throw error; }
  if (size < state.offset) throw new Error("Passive journal was truncated; checkpoint cannot be advanced safely");
  if (size === state.offset) return state;
  const lines = createInterface({ input: createReadStream(journal, { start: state.offset, end: size - 1 }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) observe(state, JSON.parse(line));
    }
  } finally { lines.close(); }
  state.offset = size;
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(state) + "\n", { mode: 0o600 });
    await fs.rename(tmp, file);
  } finally { await fs.unlink(tmp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  return state;
}

export function passiveSummary(state) {
  if (!state?.turns?.length) return "尚无被动检查点；不能推断历史任务为空。";
  const recent = state.turns.slice(-3);
  return recent.map(t => {
    const lifecycle = t.lifecycle === "Stop" ? "收到 Stop，完成与否未知"
      : t.lifecycle === "no_end_observed" ? "未观察到结束事件，完成与否未知" : `收到 ${t.lifecycle}，可能中断，完成与否未知`;
    return `${t.harness}/${t.sessionId}；${t.at}；${lifecycle}\n请求：${short(t.request, 360)}\n`
      + t.tools.slice(-3).map(tool => `${tool.name} ${short(tool.detail, 120)} → ${tool.status}${tool.exitCode === undefined ? "" : ` exit=${tool.exitCode}`}${tool.error ? ` ${short(tool.error, 80)}` : ""}`).join("\n")
      + (t.reply ? `\n回复节选（来源陈述）：${short(t.reply, 260)}` : "")
      + (t.omittedTools || t.tools.length > 3 ? "\n其余操作未展开，不能据此推断没有其他操作。" : "");
  }).reverse().join("\n\n") + `\n被动记录仅描述已观察事件；工具返回/exit=0 不等于任务验收通过。${state.omittedTurns || state.turns.length > 3 ? "更早轮次未展开，" : ""}完整记录按需查阅，不自动推断待办。`;
}
