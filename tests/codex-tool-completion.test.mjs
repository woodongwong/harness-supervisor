import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { AutoHandoff, autoStatus, enableWorkspace } from "../src/auto-handoff.mjs";
import { completedCodexTools, readCodexToolCompletions } from "../src/codex-tool-completion.mjs";

function fixture(cwd = "/example", startAt = "2026-01-01T00:00:00Z") {
  const at = n => new Date(Date.parse(startAt) + n).toISOString();
  const owner = { harness: "codex", sessionId: "c", turnId: "t", key: "codex:c", startAt, active: true };
  const state = { cwd, owner, tools: { shell: { key: owner.key, turnId: "t" } } };
  const events = [{ at: at(1), source: "codex-hook", payload: { hook_event_name: "PreToolUse",
    session_id: "c", turn_id: "t", tool_use_id: "shell", tool_name: "Bash", tool_input: { command: "echo example" } } }];
  const rows = [
    { type: "session_meta", payload: { id: "c" } },
    { type: "turn_context", payload: { turn_id: "t", cwd } },
    { type: "event_msg", timestamp: at(2), payload: { type: "item_completed", thread_id: "c", turn_id: "t",
      item: { type: "CommandExecution", id: "shell", process_id: "123", status: "completed", exit_code: 0,
        cwd: pathToFileURL(cwd).href, command: ["/bin/bash", "-lc", "echo example"] } } },
  ];
  return { state, events, rows };
}

test("native command receipt resolves exact call without needing Stop or shell polling", () => {
  const f = fixture();
  assert.deepEqual(completedCodexTools(f.state, f.events, f.rows), [{ id: "shell", at: f.rows[2].timestamp,
    reason: "codex_native_command_completed", outcome: "returned", exitCode: 0 }]);
  f.rows[2].payload.item.status = "failed";
  f.rows[2].payload.item.exit_code = 1;
  assert.equal(completedCodexTools(f.state, f.events, f.rows)[0].exitCode, 1);
});

test("receipt recovery rejects wrong identities, unknown status, ambiguous calls and missing exit evidence", () => {
  const mutations = [
    f => { f.state.owner.harness = "zcode"; },
    f => { f.state.tools.shell.key = "codex:other"; },
    f => { f.state.tools.shell.turnId = "other"; },
    f => { f.rows[0].payload.id = "other"; },
    f => { f.rows[1].payload.turn_id = "other"; },
    f => { f.rows[1].payload.cwd = "/other"; },
    f => { f.rows[2].payload.thread_id = "other"; },
    f => { f.rows[2].payload.turn_id = "other"; },
    f => { f.rows[2].payload.item.id = "other"; },
    f => { f.rows[2].payload.item.cwd = "relative/path"; },
    f => { f.events[0].payload.tool_input.workdir = "/expected"; f.rows[2].payload.item.cwd = "file:///other"; },
    f => { f.rows[2].payload.item.cwd = "file://remote/path"; },
    f => { f.rows[2].payload.item.type = "McpToolCall"; },
    f => { f.rows[2].payload.item.status = "in_progress"; },
    f => { f.rows[2].payload.item.exit_code = null; },
    f => { f.rows[2].payload.item.exit_code = "0"; },
    f => { f.rows[2].payload.item.command[2] = "other"; },
    f => { f.rows[2].timestamp = "invalid"; },
    f => { f.rows[2].timestamp = f.state.owner.startAt; },
    f => { f.events[0].at = "invalid"; },
    f => { f.events[0].payload.tool_name = "mcp__work"; },
    f => { f.events[0].payload.session_id = "other"; },
    f => { f.events[0].payload.turn_id = "other"; },
    f => { f.events.push(structuredClone(f.events[0])); },
    f => { f.rows.push(structuredClone(f.rows[2])); },
    f => { f.rows.splice(1, 1); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.deepEqual(completedCodexTools(f.state, f.events, f.rows), [], mutate.toString());
  }
});

test("explicit execution cwd may differ from the native session workspace", () => {
  const f = fixture();
  f.rows[2].payload.item.cwd = "file:///helper-checkout";
  assert.equal(completedCodexTools(f.state, f.events, f.rows).length, 1);
  f.rows[1].payload.cwd = "/other-session-workspace";
  assert.deepEqual(completedCodexTools(f.state, f.events, f.rows), []);
});

test("large TUI output does not hide the owning context from receipt recovery", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-large-receipt-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = fixture(dir), file = path.join(dir, "native.jsonl");
  f.events[0].payload.transcript_path = file;
  f.rows.splice(2, 0, { type: "response_item", payload: { type: "custom_tool_call_output", output: "x".repeat(5 * 1024 * 1024) } });
  await fs.writeFile(file, f.rows.map(JSON.stringify).join("\n") + "\n");
  assert.equal((await readCodexToolCompletions(f.state, f.events)).length, 1);
});

test("missing or truncated native tool receipts retain reservations", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-receipts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "native.jsonl"), f = fixture(dir);
  f.events[0].payload.transcript_path = file;
  assert.deepEqual(await readCodexToolCompletions(f.state, f.events), []);
  await fs.writeFile(file, f.rows.map(JSON.stringify).join("\n") + '\n{"type":');
  assert.deepEqual(await readCodexToolCompletions(f.state, f.events), []);
  await fs.writeFile(file, f.rows.map(JSON.stringify).join("\n") + "\n");
  assert.equal((await readCodexToolCompletions(f.state, f.events)).length, 1);
});

test("SessionEnd followed by resume recovers two native shell receipts and an orphan patch together", async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "relay-receipts-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, "state"), file = path.join(cwd, "native.jsonl");
  await enableWorkspace(root, cwd);
  const auto = new AutoHandoff({ root, waitMs: 5 });
  const send = (hook, extras = {}) => auto.handle("codex", { cwd, session_id: "c", turn_id: "t", transcript_path: file,
    hook_event_name: hook, ...extras });
  await send("UserPromptSubmit", { prompt: "work" });
  const state = await autoStatus(root, cwd);
  const f = fixture(cwd, state.owner.startAt);
  for (const id of ["patch", "shell", "shell2"]) await send("PreToolUse", { tool_use_id: id,
    tool_name: id === "patch" ? "apply_patch" : "Bash", tool_input: { command: "echo example" } });
  f.rows[2].timestamp = new Date().toISOString();
  const second = structuredClone(f.rows[2]); second.payload.item.id = "shell2";
  const end = { type: "event_msg", timestamp: new Date().toISOString(), payload: { type: "task_complete", turn_id: "t" } };
  await fs.writeFile(file, [...f.rows, second, end].map(JSON.stringify).join("\n") + "\n");
  // SessionEnd marks the owner inactive, but does not establish tool completion.
  await send("SessionEnd", { turn_id: undefined });
  const stopped = await autoStatus(root, cwd);
  assert.equal(stopped.owner.active, false);
  assert.equal(Object.keys(stopped.tools).length, 3);
  const result = await send("UserPromptSubmit", { turn_id: "next", prompt: "continue" });
  assert.ok(result.hookSpecificOutput.additionalContext);
  const after = await autoStatus(root, cwd);
  assert.deepEqual(after.tools, {});
  assert.equal(after.owner.turnId, "next");
  const journal = await auto.store.readEvents(state.taskId);
  assert.equal(journal.find(e => e.type === "task.tools_reconciled").tools.length, 2);
  assert.equal(journal.find(e => e.type === "task.native_turn_reconciled").tools.length, 1);
  assert.equal(journal.some(e => e.payload?.hook_event_name === "Stop"), false);
});

test("completed shell receipts never release another shell still lacking an exit code", () => {
  const f = fixture();
  f.state.tools.pending = { ...f.state.tools.shell };
  const pre = structuredClone(f.events[0]); pre.payload.tool_use_id = "pending"; f.events.push(pre);
  const receipt = structuredClone(f.rows[2]); receipt.payload.item.id = "pending";
  receipt.payload.item.status = "in_progress"; delete receipt.payload.item.exit_code; f.rows.push(receipt);
  assert.deepEqual(completedCodexTools(f.state, f.events, f.rows).map(t => t.id), ["shell"]);
});
