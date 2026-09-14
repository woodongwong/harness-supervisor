import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutoHandoff, enableWorkspace, autoStatus, autoDirectory } from "../src/auto-handoff.mjs";
import { stoppedPatchCalls } from "../src/tool-reconciliation.mjs";

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
