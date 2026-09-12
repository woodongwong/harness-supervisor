import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildHandoffContext, MAX_CONTEXT_BYTES } from "../src/handoff-context.mjs";
import { captureGitState } from "../src/git-state.mjs";
import { AutoHandoff, enableWorkspace, autoStatus } from "../src/auto-handoff.mjs";

const hook = (name, extra = {}) => ({ source: "zcode-hook", payload: { session_id: "one", hook_event_name: name, ...extra } });
const basic = { task: { id: "task-summary", goal: "Fix login", owner: "codex" }, taskDir: "/state/tasks/task-summary", git: { available: false, error: "Git 不可用" } };

test("large Chinese/emoji histories have a byte cap without losing latest request or source location", () => {
  const huge = "中文🙂".repeat(30000);
  const context = buildHandoffContext({ ...basic,
    task: { ...basic.task, goal: huge },
    git: { available: true, status: huge, diff: huge, stagedDiff: huge },
    events: [hook("UserPromptSubmit", { prompt: "LATEST_REQUIREMENT " + huge }), hook("Stop", { last_assistant_message: "PARTIAL_PROGRESS " + huge }),
      hook("PostToolUseFailure", { error: huge })], feedback: huge,
  });
  assert.ok(Buffer.byteLength(context) <= MAX_CONTEXT_BYTES);
  assert.ok(!context.includes("\uFFFD"));
  assert.match(context, /LATEST_REQUIREMENT/);
  assert.match(context, /PARTIAL_PROGRESS/);
  assert.match(context, /日志目录：\/state\/tasks\/task-summary/);
});

test("summarizes real command evidence without raw Read responses or echoed handoff content", () => {
  const context = buildHandoffContext({ ...basic, events: [
    hook("PreToolUse", { tool_use_id: "read", tool_name: "Read", tool_input: { file_path: basic.taskDir + "/context.md" } }),
    hook("PostToolUse", { tool_use_id: "read", tool_name: "Read", tool_response: "RECURSIVE_BODY".repeat(10000) }),
    hook("PreToolUse", { tool_use_id: "test", tool_name: "Bash", tool_input: { command: "npm test" } }),
    hook("PostToolUse", { tool_use_id: "test", tool_name: "Bash", tool_response: { exit_code: 1, stdout: "GIANT_OUTPUT".repeat(10000) } }),
    hook("Stop", { last_assistant_message: "# 交接摘要\nRECURSIVE_BODY" }),
  ] });
  assert.match(context, /npm test → exit=1/);
  assert.doesNotMatch(context, /RECURSIVE_BODY|GIANT_OUTPUT|tool_response/);
});

test("non-repository Git emits one short error and repositories return diff statistics only", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-git-summary-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const empty = await captureGitState(dir);
  assert.equal(empty.available, false);
  assert.equal(empty.diff, "");
  assert.equal(empty.stagedDiff, "");
  assert.doesNotMatch(JSON.stringify(empty), /usage:|Diff output format/);
  assert.ok(Buffer.byteLength(JSON.stringify(empty)) < 600);
  execFileSync("git", ["init", "-q", dir]);
  await fs.writeFile(path.join(dir, "sample.txt"), "first\n");
  execFileSync("git", ["-C", dir, "add", "sample.txt"]);
  await fs.writeFile(path.join(dir, "sample.txt"), "first\nRAW_DIFF_SENTINEL\n");
  const changed = await captureGitState(dir);
  assert.equal(changed.available, true);
  assert.match(changed.status, /sample.txt/);
  assert.match(changed.diff, /sample.txt/);
  assert.match(changed.stagedDiff, /sample.txt/);
  assert.doesNotMatch(changed.diff, /RAW_DIFF_SENTINEL/);
});

test("repeated handoffs never ingest their own read result; refreshing backs up and leaves ownership unchanged", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-context-loop-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "store");
  await enableWorkspace(root, dir);
  const auto = new AutoHandoff({ root });
  const send = (session, name, extra = {}) => auto.handle(session === "c" ? "codex" : "zcode", { cwd: dir, session_id: session, hook_event_name: name, ...extra });
  let id;
  for (let i = 0; i < 6; i++) {
    const session = i % 2 ? "z" : "c";
    const response = await send(session, "UserPromptSubmit", { prompt: `Continue step ${i}` });
    id = (await autoStatus(root, dir)).taskId;
    const file = auto.store.contextPath(id);
    const doc = await fs.readFile(file, "utf8");
    assert.equal(response.hookSpecificOutput.additionalContext, doc);
    await send(session, "PreToolUse", { tool_use_id: "read", tool_name: "Read", tool_input: { file_path: file } });
    await send(session, "PostToolUse", { tool_use_id: "read", tool_name: "Read", tool_response: "RECURSIVE_BODY " + doc });
    await send(session, "Stop", { last_assistant_message: `Step ${i} complete; next step pending` });
    assert.ok(Buffer.byteLength(doc) < 5000);
    assert.doesNotMatch(doc, /RECURSIVE_BODY/);
  }
  const events = await fs.readFile(auto.store.externalEventsPath(id), "utf8");
  assert.doesNotMatch(events, /RECURSIVE_BODY/);
  assert.match(events, /handoff_content_omitted/);
  const before = await fs.readFile(auto.store.contextPath(id), "utf8");
  const state = await autoStatus(root, dir);
  const refreshed = await auto.refreshContext(id);
  assert.equal(await fs.readFile(refreshed.backup, "utf8"), before);
  assert.deepEqual(await autoStatus(root, dir), state);
  await send("z", "UserPromptSubmit", { prompt: "working" });
  await assert.rejects(auto.refreshContext(id), /仍在运行/);
});
