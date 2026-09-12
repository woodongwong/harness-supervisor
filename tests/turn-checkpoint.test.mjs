import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { completedTurns, selectPreviousTurn } from "../src/turn-checkpoint.mjs";
import { buildHandoffContext } from "../src/handoff-context.mjs";
import { summarizeStatus } from "../src/git-state.mjs";
import { AutoHandoff, autoStatus, enableWorkspace } from "../src/auto-handoff.mjs";
import { installHandoffSkill } from "../src/auto-install.mjs";

const event = (harness, id, name, at, extra = {}) => ({ source: `${harness}-hook`, at, payload: { session_id: id, hook_event_name: name, ...extra } });
const history = [
  event("codex", "old", "UserPromptSubmit", "01", { prompt: "this istest" }),
  event("codex", "old", "Stop", "02", { last_assistant_message: "旧测试收到" }),
  event("zcode", "z", "UserPromptSubmit", "03", { prompt: "交接文件在哪" }),
  event("zcode", "z", "Stop", "04", { last_assistant_message: "旧转录在 /old/rollout.jsonl" }),
  event("codex", "latest", "UserPromptSubmit", "05", { prompt: "这个项目是做什么的？" }),
  event("codex", "latest", "Stop", "06", { last_assistant_message: "产业项目管理系统后端，包含管理端与工作台 API。" }),
  event("zcode", "new", "UserPromptSubmit", "07", { prompt: "继续之前 Codex 的任务，说明进展" }),
];

test("handoff follows the latest relevant request and answer, not initial goal or old transcript references", () => {
  const previous = selectPreviousTurn(history, "zcode");
  assert.equal(previous.sessionId, "latest");
  assert.equal(previous.request, "这个项目是做什么的？");
  const summary = buildHandoffContext({ task: { id: "task-test", goal: "this istest" }, events: history,
    target: "zcode", git: { available: false, error: "not git" }, taskDir: "/state/task-test" });
  assert.match(summary, /这个项目是做什么的/);
  assert.match(summary, /产业项目管理系统后端/);
  assert.doesNotMatch(summary, /this istest|旧转录|旧测试收到/);
});

test("stored turn requests survive a truncated event window and explicit source never substitutes another harness", () => {
  const saved = completedTurns(history);
  const selected = selectPreviousTurn(history.slice(5), "zcode", saved);
  assert.equal(selected.request, "这个项目是做什么的？");
  assert.equal(selectPreviousTurn([history.at(-1)], "zcode", { zcode: saved.zcode }), null);
});

test("normalized checkpoints support additional harness identities without a two-harness assumption", () => {
  const events = [
    event("third-harness", "third", "UserPromptSubmit", "08", { prompt: "implement feature" }),
    event("third-harness", "third", "Stop", "09", { last_assistant_message: "Feature added; tests pending" }),
    event("zcode", "new", "UserPromptSubmit", "10", { prompt: "Continue third-harness work" }),
  ];
  const checkpoint = selectPreviousTurn([...history, ...events], "zcode");
  assert.equal(checkpoint.harness, "third-harness");
  assert.equal(checkpoint.request, "implement feature");
  assert.match(checkpoint.reply, /tests pending/);
});

test("missing requested harness does not leak another harness reply into the summary", () => {
  const summary = buildHandoffContext({ task: { id: "missing", goal: "initial" },
    events: history.filter(e => e.source === "zcode-hook"), target: "zcode",
    git: { available: false, error: "not git" }, taskDir: "/state/missing" });
  assert.match(summary, /没有最终回复记录/);
  assert.doesNotMatch(summary, /旧转录|old\/rollout/);
});

test("long completed turns retain explicit remaining work at the end of their reply", () => {
  const summary = buildHandoffContext({ task: { id: "task-dev", goal: "implement", worktree: {} }, target: "zcode", taskDir: "/state/task-dev", git: { available: false, error: "not git" },
    events: [event("codex", "dev", "UserPromptSubmit", "01", { prompt: "implement" }),
      event("codex", "dev", "Stop", "02", { last_assistant_message: "Implementation details ".repeat(1000) + "TODO: run migration tests before shipping" }),
      event("zcode", "new", "UserPromptSubmit", "03", { prompt: "continue Codex" })] });
  assert.match(summary, /TODO: run migration tests before shipping/);
});

test("Git overview groups thousands of vendor entries and handles renamed paths without counting them twice", () => {
  const rows = Array.from({ length: 2326 }, (_, i) => `A  vendor/package/file${i}.php\0`).join("");
  const summary = summarizeStatus(rows + "A  .gitignore\0?? application/\0R  renamed.php\0old.php\0");
  assert.match(summary, /vendor\/ 2326 项/);
  assert.match(summary, /暂存 2328 项/);
  assert.doesNotMatch(summary, /file0\.php|old.php/);
  assert.ok(Buffer.byteLength(summary) < 600);
});

test("completed requests persist across auto-handoff restart even after the recent journal window rolls over", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-checkpoint-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "state");
  await enableWorkspace(root, dir);
  const auto = new AutoHandoff({ root });
  const input = { cwd: dir, session_id: "c" };
  await auto.handle("codex", { ...input, hook_event_name: "UserPromptSubmit", prompt: "Describe PROJECT_X" });
  await auto.handle("codex", { ...input, hook_event_name: "Stop", last_assistant_message: "PROJECT_X is an API backend" });
  const state = await autoStatus(root, dir);
  assert.equal(state.checkpoints.codex.request, "Describe PROJECT_X");
  for (let i = 0; i < 205; i++) await auto.store.appendEvent(state.taskId, { type: "irrelevant", sequence: i });
  const restarted = new AutoHandoff({ root });
  const response = await restarted.handle("zcode", { cwd: dir, session_id: "z", hook_event_name: "UserPromptSubmit", prompt: "继续 Codex 的任务" });
  assert.match(response.hookSpecificOutput.additionalContext, /Describe PROJECT_X/);
  assert.match(response.hookSpecificOutput.additionalContext, /PROJECT_X is an API backend/);
});

test("skill installation shares the maintained source with both clients and preserves unrelated skills", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-skills-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const options = { codexHome: path.join(dir, "codex"), zcodeHome: path.join(dir, "zcode", "cli") };
  const targets = await installHandoffSkill(options);
  assert.equal(await fs.realpath(targets[0]), await fs.realpath(targets[1]));
  assert.deepEqual(await installHandoffSkill(options), targets);
  await fs.unlink(targets[1]);
  await fs.mkdir(targets[1]);
  await fs.writeFile(path.join(targets[1], "SKILL.md"), "user authored");
  await assert.rejects(installHandoffSkill(options), /保留原文件/);
  assert.equal(await fs.readFile(path.join(targets[1], "SKILL.md"), "utf8"), "user authored");
});
