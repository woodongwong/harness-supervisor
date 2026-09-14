import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutoHandoff, autoStatus, enableWorkspace } from "../src/auto-handoff.mjs";
import { refreshPassiveCheckpoint } from "../src/passive-checkpoint.mjs";

async function fixture(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "relay-passive-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, "state");
  await enableWorkspace(root, cwd);
  const auto = new AutoHandoff({ root, waitMs: 1 });
  const send = (harness, hook, extras = {}) => auto.handle(harness, { cwd, session_id: `${harness}-session`,
    turn_id: "first", hook_event_name: hook, ...extras });
  const checkpoint = async () => {
    const state = await autoStatus(root, cwd);
    return JSON.parse(await fs.readFile(path.join(auto.store.taskDir(state.taskId), "passive.json"), "utf8"));
  };
  return { cwd, root, auto, send, checkpoint };
}

test("both harnesses continue without final replies or agent notes; Codex also supports interruption without Stop", async t => {
  for (const source of ["codex", "zcode"]) {
    const f = await fixture(t);
    const target = source === "codex" ? "zcode" : "codex";
    await f.send(source, "UserPromptSubmit", { prompt: "Repair login and run checks" });
    await f.send(source, "PreToolUse", { tool_use_id: "edit", tool_name: "Edit", tool_input: { file_path: "login.js" } });
    assert.equal((await f.checkpoint()).turns[0].tools[0].status, "unconfirmed");
    await f.send(source, "PostToolUse", { tool_use_id: "edit", tool_name: "Edit" });
    await f.send(source, "PreToolUse", { tool_use_id: "test", tool_name: "Bash", tool_input: { command: "node --test login.test.js" } });
    await f.send(source, "PostToolUse", { tool_use_id: "test", tool_name: "Bash", tool_response: { exit_code: 1 } });
    const endEvent = source === "codex" ? "Interrupt" : "Stop";
    await f.send(source, endEvent);
    const state = await autoStatus(f.root, f.cwd);
    assert.equal((await f.auto.store.require(state.taskId)).progress, undefined);
    const restarted = new AutoHandoff({ root: f.root });
    const output = await restarted.handle(target, { cwd: f.cwd, session_id: "destination", turn_id: "next",
      hook_event_name: "UserPromptSubmit", prompt: `Continue ${source}'s task` });
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /Repair login and run checks/);
    assert.match(context, /login.js/);
    assert.match(context, /exit=1/);
    assert.ok(context.includes(endEvent));
    assert.match(context, /完成与否未知/);
    assert.ok(Buffer.byteLength(context) <= 8192);
    await f.send(source, "PostToolUse", { tool_use_id: "late", tool_name: "Bash" });
    assert.equal((await f.checkpoint()).turns.some(turn => turn.tools.some(tool => tool.id === "late")), false);
  }
});

test("missing end or pending tools keeps ownership fenced while passive work is saved", async t => {
  const f = await fixture(t);
  await f.send("codex", "UserPromptSubmit", { prompt: "long operation" });
  await f.send("codex", "PreToolUse", { tool_use_id: "running", tool_name: "Bash", tool_input: { command: "long-operation" } });
  assert.equal((await f.send("zcode", "UserPromptSubmit", { prompt: "continue" })).continue, false);
  await f.send("codex", "Interrupt");
  assert.equal((await f.send("zcode", "UserPromptSubmit", { prompt: "continue" })).continue, false);
  const saved = await f.checkpoint();
  assert.equal(saved.turns.length, 1);
  assert.equal(saved.turns[0].tools[0].status, "unconfirmed");
  await f.send("codex", "PostToolUse", { tool_use_id: "running", tool_name: "Bash", tool_response: { exit_code: 0 } });
  assert.ok((await f.send("zcode", "UserPromptSubmit", { prompt: "continue" })).hookSpecificOutput.additionalContext);
});

test("journal replay recovers projection write loss and retains requests beyond the recent event window", async t => {
  const f = await fixture(t);
  await f.send("codex", "UserPromptSubmit", { prompt: "Preserve this original objective" });
  const state = await autoStatus(f.root, f.cwd);
  const file = path.join(f.auto.store.taskDir(state.taskId), "passive.json");
  const old = await fs.readFile(file, "utf8");
  const rows = Array.from({ length: 220 }, (_, i) => JSON.stringify({ at: new Date().toISOString(), source: "codex-hook",
    payload: { session_id: "codex-session", turn_id: "first", hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_use_id: `tool-${i}`, tool_input: { command: `check-${i}` }, tool_response: { exit_code: 0 } } }));
  await fs.appendFile(f.auto.store.externalEventsPath(state.taskId), rows.join("\n") + "\n");
  const refreshed = await refreshPassiveCheckpoint(f.auto.store, state.taskId);
  assert.equal(refreshed.turns[0].request, "Preserve this original objective");
  assert.equal(refreshed.turns[0].tools.length, 16);
  assert.equal(refreshed.turns[0].omittedTools, 204);
  await fs.writeFile(file, old); // Crash left the previous atomic projection.
  assert.deepEqual(await refreshPassiveCheckpoint(f.auto.store, state.taskId), refreshed);
  assert.deepEqual(await refreshPassiveCheckpoint(f.auto.store, state.taskId), refreshed);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("an intervening question retains earlier observed work and another workspace sees none of it", async t => {
  const f = await fixture(t);
  await f.send("zcode", "UserPromptSubmit", { prompt: "Implement the unique feature" });
  await f.send("zcode", "PostToolUse", { tool_use_id: "edit", tool_name: "Edit", tool_input: { file_path: "feature.js" } });
  await f.send("zcode", "Stop", { last_assistant_message: "Implementation saved; tests remain unverified." });
  await f.send("zcode", "UserPromptSubmit", { turn_id: "question", prompt: "What is this project?" });
  await f.send("zcode", "Stop", { turn_id: "question", last_assistant_message: "A sample application." });
  const output = await f.send("codex", "UserPromptSubmit", { prompt: "continue" });
  assert.match(output.hookSpecificOutput.additionalContext, /unique feature/);
  assert.match(output.hookSpecificOutput.additionalContext, /tests remain unverified/);
  const other = path.join(f.cwd, "other");
  await fs.mkdir(other);
  await enableWorkspace(f.root, other);
  const clean = await f.auto.handle("codex", { cwd: other, session_id: "other", turn_id: "other", hook_event_name: "UserPromptSubmit", prompt: "independent work" });
  assert.doesNotMatch(clean.hookSpecificOutput.additionalContext, /unique feature|feature.js/);
});
