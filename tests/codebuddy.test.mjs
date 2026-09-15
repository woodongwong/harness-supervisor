import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutoHandoff, autoStatus, enableWorkspace } from "../src/auto-handoff.mjs";
import { installAuto, hookGroups } from "../src/auto-install.mjs";
import { cancelledCodeBuddyTools } from "../src/codebuddy-reconciliation.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-codebuddy-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "state");
  await enableWorkspace(root, dir);
  const auto = new AutoHandoff({ root, waitMs: 1 });
  const send = (hook, extra = {}) => auto.handle("codebuddy", { cwd: dir, session_id: "buddy-session",
    generation_id: "generation-one", hook_event_name: hook, ...extra });
  return { dir, root, auto, send };
}

test("CodeBuddy native generations and parallel call ids survive bidirectional handoff", async t => {
  const f = await fixture(t);
  await f.auto.handle("codex", { cwd: f.dir, session_id: "codex-source", turn_id: "turn-c", hook_event_name: "UserPromptSubmit", prompt: "repair feature" });
  await f.auto.handle("codex", { cwd: f.dir, session_id: "codex-source", turn_id: "turn-c", hook_event_name: "Stop", last_assistant_message: "source-context-marker" });
  assert.match((await f.send("UserPromptSubmit", { prompt: "continue Codex" })).hookSpecificOutput.additionalContext, /source-context-marker/);
  for (const call_id of ["parallel-a", "parallel-b"]) await f.send("PreToolUse", { call_id, tool_name: "Bash", tool_input: { command: "same-command" } });
  await f.send("PostToolUse", { call_id: "parallel-a", tool_name: "Bash" });
  assert.deepEqual(Object.keys((await autoStatus(f.root, f.dir)).tools), ["parallel-b"]);
  await f.send("PostToolUse", { generation_id: "old-generation", call_id: "parallel-b", tool_name: "Bash" });
  assert.equal(Object.keys((await autoStatus(f.root, f.dir)).tools).length, 1);
  await f.send("PostToolUseFailure", { call_id: "parallel-b", tool_name: "Bash", error: "operation failed" });
  await f.send("Stop", { last_assistant_message: "buddy-result-marker" });
  const output = await f.auto.handle("zcode", { cwd: f.dir, session_id: "z-target", turn_id: "z-turn", hook_event_name: "UserPromptSubmit", prompt: "continue CodeBuddy" });
  assert.match(output.hookSpecificOutput.additionalContext, /buddy-result-marker/);
  assert.equal((await autoStatus(f.root, f.dir)).owner.harness, "zcode");
  assert.equal((await f.send("PreToolUse", { call_id: "stale", tool_name: "Write" })).hookSpecificOutput.permissionDecision, "deny");
});

test("CodeBuddy missing identities fail closed and unidentified SessionEnd does not release a turn", async t => {
  const f = await fixture(t);
  await f.send("UserPromptSubmit", { prompt: "work" });
  await f.send("SessionEnd", { generation_id: undefined });
  assert.equal((await autoStatus(f.root, f.dir)).owner.active, true);
  const noId = await f.send("PreToolUse", { tool_name: "Bash" });
  assert.equal(noId.hookSpecificOutput.permissionDecision, "deny");
  const script = fileURLToPath(new URL("../src/auto-hook.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "codebuddy", f.root], { encoding: "utf8", input: JSON.stringify({ cwd: f.dir,
    session_id: "buddy-session", hook_event_name: "PreToolUse", call_id: "one", tool_name: "Bash" }) });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual((await autoStatus(f.root, f.dir)).tools, {});
  assert.equal((await f.send("PreToolUse", { call_id: "agent", tool_name: "Agent" })).hookSpecificOutput.permissionDecision, "deny");
});

test("selective CodeBuddy installation preserves other settings and is idempotent without enabling a workspace", async t => {
  const f = await fixture(t);
  const codebuddyHome = path.join(f.dir, "buddy");
  const codexHome = path.join(f.dir, "codex");
  const zcodeHome = path.join(f.dir, "zcode", "cli");
  await fs.mkdir(codebuddyHome);
  const file = path.join(codebuddyHome, "settings.json");
  const original = { model: "existing-model", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo unrelated" }] }] } };
  await fs.writeFile(file, JSON.stringify(original));
  const options = { root: f.root, harnesses: ["codebuddy"], codebuddyHome, codexHome, zcodeHome };
  const first = await installAuto(options);
  assert.equal(first.cwd, null);
  assert.deepEqual(first.files, [file]);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.model, original.model);
  assert.equal(saved.hooks.Stop[0].hooks[0].command, "echo unrelated");
  assert.equal(JSON.parse(await fs.readFile(first.backups[0], "utf8")).model, "existing-model");
  assert.equal((await installAuto(options)).backups.length, 0);
  await assert.rejects(fs.stat(codexHome), { code: "ENOENT" });
  await assert.rejects(fs.stat(zcodeHome), { code: "ENOENT" });
  assert.ok((await fs.readFile(path.join(codebuddyHome, "skills", "harness-handoff", "SKILL.md"), "utf8")).includes("Passive continuity"));
  const groups = hookGroups("codebuddy", f.root);
  assert.equal(groups.Interrupt, undefined);
  assert.ok(groups.PostToolUseFailure && groups.SessionEnd);
});

test("interactive user cancellation without completion hooks allows the same session to resume", async t => {
  const f = await fixture(t);
  const transcript = path.join(f.dir, "transcript.jsonl");
  const tool_input = { command: "node read-state.mjs", description: "read state" };
  const callAt = Date.now() - 1000;
  await f.send("UserPromptSubmit", { prompt: "continue" });
  await f.send("PreToolUse", { tool_use_id: "cancelled", tool_name: "Bash", tool_input, transcript_path: transcript });
  const source = { sessionId: "buddy-session", cwd: f.dir, providerData: { conversationRequestId: "generation-one" } };
  const call = { ...source, timestamp: callAt, type: "function_call", name: "Bash", callId: "cancelled", arguments: JSON.stringify(tool_input) };
  const result = { ...source, id: "rejection-record", timestamp: Date.now(), type: "function_call_result", name: "Bash", callId: "cancelled",
    status: "incomplete", providerData: { ...source.providerData, skipRun: true, error: "No (tell CodeBuddy what to do differently)" },
    output: { type: "text", text: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed. " } };
  const state = await autoStatus(f.root, f.dir);
  const events = await f.auto.store.readEvents(state.taskId);
  assert.equal(cancelledCodeBuddyTools(state, events, [call, result])[0].outcome, "not_started");
  for (const change of [
    { callId: "different" }, { sessionId: "different" }, { cwd: "/other" }, { status: "completed" },
    { output: { type: "text", text: "Command failed" } },
    { providerData: { ...result.providerData, skipRun: false } },
    { providerData: { ...result.providerData, conversationRequestId: "different" } },
    { timestamp: callAt - 1000 },
  ]) assert.deepEqual(cancelledCodeBuddyTools(state, events, [call, { ...result, ...change }]), []);
  await fs.writeFile(transcript, [call, result].map(r => JSON.stringify(r)).join("\n") + "\n");
  // Even an exact rejection cannot prove the whole session stopped.
  const other = await f.auto.handle("codex", { cwd: f.dir, session_id: "other", turn_id: "other", hook_event_name: "UserPromptSubmit", prompt: "continue" });
  assert.equal(other.continue, false);
  assert.deepEqual((await autoStatus(f.root, f.dir)).tools, {});
  assert.equal((await autoStatus(f.root, f.dir)).owner.active, true);
  const next = await f.send("UserPromptSubmit", { generation_id: "generation-two", prompt: "continue after cancellation" });
  assert.ok(next.hookSpecificOutput.additionalContext);
  await f.send("PostToolUseFailure", { generation_id: "generation-one", call_id: "cancelled", tool_name: "Bash" });
  assert.equal((await autoStatus(f.root, f.dir)).owner.turnId, "generation-two");
  assert.equal((await f.auto.store.readEvents(state.taskId)).filter(e => e.type === "task.tools_reconciled").length, 1);
});
