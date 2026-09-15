import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutoHandoff, enableWorkspace, autoStatus, autoDirectory } from "../src/auto-handoff.mjs";
import { completedCodexTurn, readCompletedCodexTurn } from "../src/codex-turn-reconciliation.mjs";

function evidence(cwd, at = new Date().toISOString()) {
  return [
    { type: "session_meta", payload: { id: "c" } },
    { type: "turn_context", payload: { turn_id: "t", cwd } },
    { type: "event_msg", timestamp: at, payload: { type: "task_complete", turn_id: "t", last_agent_message: "Patch validation failed." } },
  ];
}

test("native completion requires exact session, cwd, turn and terminal timestamp", () => {
  const state = { cwd: "/example", owner: { harness: "codex", sessionId: "c", turnId: "t", startAt: "2026-01-01T00:00:00Z" } };
  const rows = evidence(state.cwd, "2026-01-01T00:01:00Z");
  assert.equal(completedCodexTurn(state, rows).reason, "codex_native_task_complete");
  const mutations = [
    r => { r[0].payload.id = "other"; },
    r => { r[1].payload.cwd = "/another-worktree"; },
    r => { r[1].payload.turn_id = "other"; },
    r => { r[2].payload.turn_id = "other"; },
    r => { r[2].payload.type = "agent_message"; },
    r => { r[2].timestamp = "invalid"; },
    r => { r[2].timestamp = "2025-01-01T00:00:00Z"; },
    r => { r.splice(1, 1); },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(rows); mutate(copy);
    assert.equal(completedCodexTurn(state, copy), null, mutate.toString());
  }
  assert.equal(completedCodexTurn({ ...state, owner: { ...state.owner, harness: "zcode" } }, rows), null);
});

async function fixture(t, toolNames = ["apply_patch"]) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "relay-native-end-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, "state");
  const file = path.join(cwd, "native.jsonl");
  await enableWorkspace(root, cwd);
  const auto = new AutoHandoff({ root, waitMs: 5 });
  const send = (hook, extras = {}) => auto.handle("codex", { cwd, session_id: "c", turn_id: "t",
    transcript_path: file, hook_event_name: hook, ...extras });
  await send("UserPromptSubmit", { prompt: "work" });
  for (const name of toolNames) await send("PreToolUse", { tool_use_id: name, tool_name: name });
  const write = rows => fs.writeFile(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  await write(evidence(cwd));
  return { cwd, root, file, auto, send, write };
}

test("missing Stop and patch completion recover on next prompt without fabricated hooks", async t => {
  const { cwd, root, auto, send } = await fixture(t);
  const before = await autoStatus(root, cwd);
  assert.equal(before.owner.active, true);
  const next = await send("UserPromptSubmit", { turn_id: "next", prompt: "continue" });
  assert.ok(next.hookSpecificOutput.additionalContext);
  const after = await autoStatus(root, cwd);
  assert.deepEqual(after.tools, {});
  assert.equal(after.owner.turnId, "next");
  assert.equal(after.checkpoints.codex.nativeEnd, true);
  const records = await auto.store.readEvents(after.taskId);
  assert.equal(records.filter(e => e.payload?.hook_event_name === "Stop").length, 0);
  const recovered = records.filter(e => e.type === "task.native_turn_reconciled");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].tools[0].outcome, "unknown");
  assert.equal((await auto.reconcileNativeTurn(after.taskId)).changed, false);
});

test("native turn end allows another harness to receive the checkpoint", async t => {
  const { cwd, root, auto } = await fixture(t);
  const result = await auto.handle("zcode", { cwd, session_id: "z", turn_id: "next", hook_event_name: "UserPromptSubmit", prompt: "continue" });
  assert.ok(result.hookSpecificOutput.additionalContext);
  assert.match(result.hookSpecificOutput.additionalContext, /task_complete/);
  assert.equal((await autoStatus(root, cwd)).owner.harness, "zcode");
});

test("native completion preserves shell and MCP reservations and blocks takeover", async t => {
  const { cwd, root, auto, send } = await fixture(t, ["apply_patch", "Bash", "mcp__work"]);
  const state = await autoStatus(root, cwd);
  assert.deepEqual(await auto.reconcileNativeTurn(state.taskId), { changed: true, active: false, remainingTools: 2 });
  const next = await send("UserPromptSubmit", { turn_id: "next", prompt: "continue" });
  assert.equal(next.continue, false);
  assert.deepEqual(Object.keys((await autoStatus(root, cwd)).tools), ["Bash", "mcp__work"]);
});

test("maintenance clears only expired handoff waits while preserving live or invalid waits", async t => {
  const { cwd, root, auto } = await fixture(t);
  const state = await autoStatus(root, cwd);
  const file = path.join(await autoDirectory(root, cwd), "state.json");
  for (const expires of [Date.now() + 60000, null]) {
    state.pending = { key: "zcode:z", request: "pending", expires };
    // Missing expiry is unknown, rather than an expired lease.
    if (expires === null) delete state.pending.expires;
    await fs.writeFile(file, JSON.stringify(state));
    await assert.rejects(auto.reconcileNativeTurn(state.taskId), /正在交接/);
  }
  state.pending.expires = Date.now() - 1;
  await fs.writeFile(file, JSON.stringify(state));
  assert.equal((await auto.reconcileNativeTurn(state.taskId)).remainingTools, 0);
  assert.equal((await autoStatus(root, cwd)).pending, null);
});

test("missing, truncated, old or wrong-session native evidence keeps the owner fenced", async t => {
  const { cwd, root, auto, file, write } = await fixture(t);
  const state = await autoStatus(root, cwd);
  const events = await auto.store.readEvents(state.taskId);
  await fs.unlink(file);
  assert.equal(await readCompletedCodexTurn(state, events), null);
  await write(evidence(cwd));
  await fs.appendFile(file, '{"type":');
  assert.equal(await readCompletedCodexTurn(state, events), null);
  const wrong = evidence(cwd); wrong[0].payload.id = "other";
  await write(wrong);
  assert.equal((await auto.reconcileNativeTurn(state.taskId)).changed, false);
  const old = evidence(cwd); old[2].payload.turn_id = "previous";
  await write(old);
  assert.equal((await auto.reconcileNativeTurn(state.taskId)).changed, false);
  const result = await auto.handle("zcode", { cwd, session_id: "z", turn_id: "next", hook_event_name: "UserPromptSubmit", prompt: "continue" });
  assert.equal(result.continue, false);
  assert.equal((await autoStatus(root, cwd)).owner.active, true);
});
