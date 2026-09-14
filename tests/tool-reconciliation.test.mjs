import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutoHandoff, enableWorkspace, autoStatus, autoDirectory } from "../src/auto-handoff.mjs";
import { stoppedPatchCalls, rejectedShellCalls, stoppedRejectedShellCalls } from "../src/tool-reconciliation.mjs";

const owner = { key: "codex:c", harness: "codex", sessionId: "c", turnId: "t", active: false };
const event = (hook, extras = {}) => ({ source: "codex-hook", payload: {
  hook_event_name: hook, session_id: "c", turn_id: "t", ...extras,
} });

test("only a synchronous patch in the exact stopped Codex turn is reconciled", () => {
  const state = { owner, tools: { patch: { key: owner.key, turnId: "t" } } };
  const pre = event("PreToolUse", { tool_use_id: "patch", tool_name: "apply_patch" });
  const stop = event("Stop");
  assert.equal(stoppedPatchCalls(state, [pre, stop])[0].outcome, "unknown");
  for (const records of [[pre], [pre, event("Interrupt")], [pre, event("SessionEnd")],
    [pre, event("Stop", { turn_id: "other" })], [pre, event("Stop", { session_id: "other" })],
    [event("PreToolUse", { tool_use_id: "patch", tool_name: "Bash" }), stop], [stop, pre]]) {
    assert.deepEqual(stoppedPatchCalls(state, records), []);
  }
  assert.deepEqual(stoppedPatchCalls({ ...state, owner: { ...owner, active: true } }, [pre, stop]), []);
  assert.deepEqual(stoppedPatchCalls({ ...state, owner: { ...owner, harness: "zcode" } }, [pre, stop]), []);
});

function rejectedFixture() {
  const at = n => new Date(1700000000000 + n).toISOString();
  const state = { owner, tools: { shell: { key: owner.key, turnId: "t" } } };
  const events = [
    { ...event("PreToolUse", { tool_name: "Bash", tool_use_id: "shell", tool_input: { command: "echo example" } }), at: at(2) },
    { ...event("Stop"), at: at(4) },
  ];
  const transcript = [
    { type: "session_meta", payload: { id: "c" } },
    { type: "turn_context", payload: { turn_id: "t" } },
    { timestamp: at(1), type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "call-one",
      input: 'const r = await tools.exec_command({\n cmd: "echo example",\n workdir: "/tmp", yield_time_ms: 1000\n});\ntext(JSON.stringify(r));' } },
    { timestamp: at(3), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-one", output: [
      { type: "input_text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "input_text", text: 'Script error:\nexec_command failed: CreateProcess { message: "Rejected(Policy denial)" }' },
    ] } },
  ];
  return { state, events, transcript };
}

test("process rejection needs an exact session, turn, single literal call, hook and failed result", () => {
  const { state, events, transcript } = rejectedFixture();
  const result = rejectedShellCalls(state, events, transcript);
  assert.equal(result[0].outcome, "not_started");
  assert.equal(result[0].id, "shell");
  const mutations = [
    f => { f.state.owner = { ...owner, active: true }; },
    f => { f.state.owner = { ...owner, harness: "zcode" }; },
    f => { f.state.tools.shell.turnId = "other"; },
    f => { f.transcript[0].payload.id = "other"; },
    f => { f.transcript[1].payload.turn_id = "other"; },
    f => { f.transcript.splice(1, 1); },
    f => { f.transcript[3].payload.call_id = "other"; },
    f => { f.transcript[3].payload.output[0].text = "Script completed\n"; },
    f => { f.transcript[3].payload.output[1].text = "Process running with session ID 123"; },
    f => { f.transcript[3].payload.output[1].text = 'Script error:\nexec_command failed: Process exited with code 1'; },
    f => { f.events[0].payload.tool_input.command = "different"; },
    f => { f.events[0].payload.session_id = "other"; },
    f => { f.events[0].at = "invalid"; },
    f => { f.events[1].at = f.transcript[2].timestamp; },
    f => { f.events[1].payload.hook_event_name = "Interrupt"; },
    f => { f.events.push(structuredClone(f.events[0])); },
    f => { f.transcript[2].payload.input += '\nawait tools.exec_command({cmd:"echo other"});'; },
    f => { f.transcript[2].payload.input = f.transcript[2].payload.input.replace('"echo example"', 'buildCommand()'); },
    f => { f.transcript[2].payload.input = f.transcript[2].payload.input.replace('"echo example"', '`echo example`'); },
    f => { f.transcript[2].payload.input = f.transcript[2].payload.input.replace('"echo example",', '"echo example", cmd: "other",'); },
  ];
  for (const mutate of mutations) {
    const f = rejectedFixture(); mutate(f);
    assert.deepEqual(rejectedShellCalls(f.state, f.events, f.transcript), [], mutate.toString());
  }
});

test("rejected command without PostToolUse is recovered on Stop and does not block handoff", async t => {
  const { dir, root, auto, send } = await fixture(t);
  const transcriptPath = path.join(dir, "native.jsonl");
  const { transcript } = rejectedFixture();
  transcript[2].timestamp = new Date(Date.now() - 1000).toISOString();
  await send("PreToolUse", { tool_use_id: "shell", tool_name: "Bash", tool_input: { command: "echo example" }, transcript_path: transcriptPath });
  transcript[3].timestamp = new Date().toISOString();
  await fs.writeFile(transcriptPath, transcript.map(e => JSON.stringify(e)).join("\n") + "\n");
  await send("Stop", { transcript_path: transcriptPath });
  const state = await autoStatus(root, dir);
  assert.deepEqual(state.tools, {});
  const records = await auto.store.readEvents(state.taskId);
  assert.equal(records.find(e => e.type === "task.tools_reconciled").tools[0].outcome, "not_started");
  const next = await auto.handle("zcode", { cwd: dir, session_id: "new-session", turn_id: "next", hook_event_name: "UserPromptSubmit", prompt: "continue" });
  assert.ok(next.hookSpecificOutput.additionalContext);
});

test("unavailable or truncated native evidence keeps the shell reservation", async t => {
  const { dir } = await fixture(t);
  const { state, events, transcript } = rejectedFixture();
  const file = path.join(dir, "native.jsonl");
  events[0].payload.transcript_path = file;
  assert.deepEqual(await stoppedRejectedShellCalls(state, events), []);
  await fs.writeFile(file, transcript.map(e => JSON.stringify(e)).join("\n") + '\n{"type":');
  assert.deepEqual(await stoppedRejectedShellCalls(state, events), []);
  await fs.writeFile(file, transcript.map(e => JSON.stringify(e)).join("\n") + "\n");
  assert.equal((await stoppedRejectedShellCalls(state, events))[0].outcome, "not_started");
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-tools-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "state");
  await enableWorkspace(root, dir);
  const auto = new AutoHandoff({ root, waitMs: 5 });
  const send = (hook, extras = {}) => auto.handle("codex", { cwd: dir, session_id: "c", turn_id: "t", hook_event_name: hook, ...extras });
  await send("UserPromptSubmit", { prompt: "work" });
  return { dir, root, auto, send };
}

test("patch error without PostToolUse no longer blocks the next message after Stop", async t => {
  const { dir, root, auto, send } = await fixture(t);
  await send("PreToolUse", { tool_use_id: "patch", tool_name: "apply_patch" });
  await send("Stop", { last_assistant_message: "The patch failed validation." });
  const state = await autoStatus(root, dir);
  assert.deepEqual(state.tools, {});
  const task = await auto.store.require(state.taskId);
  assert.equal(task.status, "idle");
  const records = await auto.store.readEvents(state.taskId);
  assert.equal(records.find(e => e.type === "task.tools_reconciled").tools[0].outcome, "unknown");
  const next = await send("UserPromptSubmit", { turn_id: "next", prompt: "continue" });
  assert.ok(next.hookSpecificOutput.additionalContext);
});

test("uncompleted shell tools remain fenced even when a patch reservation is released", async t => {
  const { dir, root, auto, send } = await fixture(t);
  await send("PreToolUse", { tool_use_id: "patch", tool_name: "apply_patch" });
  await send("PreToolUse", { tool_use_id: "shell", tool_name: "Bash" });
  await send("Stop");
  assert.deepEqual(Object.keys((await autoStatus(root, dir)).tools), ["shell"]);
  const next = await send("UserPromptSubmit", { turn_id: "next", prompt: "continue" });
  assert.equal(next.continue, false);
  assert.match(next.reason, /会话已停止，但仍有 1 个工具/);
  await send("PostToolUse", { tool_use_id: "shell", tool_name: "Bash" });
  assert.ok((await send("UserPromptSubmit", { turn_id: "next", prompt: "continue" })).hookSpecificOutput.additionalContext);
});

test("preexisting orphan reservation is recovered once on the next prompt without requiring reinstall", async t => {
  const { dir, root, auto, send } = await fixture(t);
  await send("PreToolUse", { tool_use_id: "patch", tool_name: "apply_patch" });
  const state = await autoStatus(root, dir);
  // Reproduce a state saved by the previous version after a real Stop event.
  await auto.record(state.taskId, "codex", { cwd: dir, session_id: "c", turn_id: "t", hook_event_name: "Stop" });
  state.owner.active = false;
  await fs.writeFile(path.join(await autoDirectory(root, dir), "state.json"), JSON.stringify(state));
  const next = await send("UserPromptSubmit", { turn_id: "next", prompt: "continue" });
  assert.ok(next.hookSpecificOutput.additionalContext);
  assert.deepEqual((await autoStatus(root, dir)).tools, {});
  assert.equal((await auto.store.readEvents(state.taskId)).filter(e => e.type === "task.tools_reconciled").length, 1);
});
