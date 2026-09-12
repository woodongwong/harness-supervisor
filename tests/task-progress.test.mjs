import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mergeProgress, hasPendingWork, progressAssessment } from "../src/task-progress.mjs";
import { AutoHandoff, autoStatus, enableWorkspace } from "../src/auto-handoff.mjs";
import { TaskStore } from "../src/store.mjs";
import { WorktreeTasks } from "../src/worktree-tasks.mjs";
import { workspaceStatus } from "../src/task-status.mjs";
import { buildHandoffContext, MAX_CONTEXT_BYTES } from "../src/handoff-context.mjs";

const author = { harness: "third-harness", sessionId: "third-session" };
const patch = {
  title: "Login repair", goal: "Restore login without changing the API contract",
  items: [
    { id: "api", kind: "constraint", text: "Preserve response fields", status: "active" },
    { id: "fix", kind: "work", text: "Fix login handling", status: "done", evidence: "Changed auth handler" },
    { id: "regression", kind: "verification", text: "LOGIN_PENDING run regression tests", status: "pending" },
  ],
};

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-progress-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo"); await fs.mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  await fs.writeFile(path.join(repo, "base.txt"), "base");
  execFileSync("git", ["-C", repo, "add", "base.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  const store = new TaskStore(path.join(dir, "state"));
  const tasks = new WorktreeTasks({ store });
  const a = await tasks.create({ repo, name: "login", goal: "Login work" });
  const b = await tasks.create({ repo, name: "report", goal: "Report work" });
  const auto = new AutoHandoff({ root: store.root, waitMs: 300 });
  const send = (task, harness, session, name, extra = {}) => auto.handle(harness, { cwd: task.cwd, session_id: session, hook_event_name: name, ...extra });
  return { dir, repo, store, tasks, a, b, auto, send };
}

test("progress upserts retain omitted pending work, require evidence to resolve, and accept generic harness provenance", () => {
  const first = mergeProgress(undefined, patch, author);
  const second = mergeProgress(first, { items: [{ id: "fix", text: "Updated implementation notes" }] }, author);
  assert.equal(first.items[1].text, "Fix login handling");
  assert.equal(second.items[2].status, "pending");
  assert.equal(second.items[2].author.harness, "third-harness");
  assert.ok(hasPendingWork(second));
  assert.throws(() => mergeProgress(second, { items: [{ id: "regression", status: "passed" }] }, author), /evidence/);
  const done = mergeProgress(second, { items: [{ id: "regression", status: "passed", evidence: "npm test: 12 login tests passed" }] }, author);
  assert.equal(hasPendingWork(done), false);
  assert.equal(done.items.length, 3);
  assert.equal(done.revision, 3);
  assert.throws(() => mergeProgress(done, { items: [{ id: "api", status: "retired" }] }, author), /evidence/);
  assert.throws(() => mergeProgress(done, { items: [{ id: "api", kind: "work", status: "done", evidence: "x" }] }, author), /kind cannot change/);
  assert.throws(() => mergeProgress(done, { items: [{ id: "x", kind: "verification", status: "done", text: "wrong" }] }, author), /Invalid/);
  assert.throws(() => mergeProgress(done, { items: [], unexpected: true }, author), /Unknown/);
});

test("progress distinguishes absent records from pending or resolved recorded work", () => {
  assert.equal(progressAssessment(undefined), "uninitialized");
  assert.equal(progressAssessment({ revision: 0, items: [] }), "uninitialized");
  const titleOnly = mergeProgress(undefined, { title: "Question only" }, author);
  assert.equal(progressAssessment(titleOnly), "no_work_items");
  const constraintOnly = mergeProgress(titleOnly, { items: [patch.items[0]] }, author);
  assert.equal(progressAssessment(constraintOnly), "no_work_items");
  const work = mergeProgress(constraintOnly, { items: patch.items }, author);
  assert.equal(progressAssessment(work), "pending");
  const done = mergeProgress(work, { items: [{ id: "regression", status: "passed", evidence: "Tests passed" }] }, author);
  assert.equal(progressAssessment(done), "recorded_items_resolved");
});

test("snapshots keep provenance and generation time without endorsing an unverified empty backlog", () => {
  const at = "2026-09-12T08:15:12.460Z";
  const sourceReply = "没有遗留待办";
  for (const progress of [undefined, { revision: 0, items: [] }, mergeProgress(undefined, { title: "Question" }, author)]) {
    const context = buildHandoffContext({ task: { id: "task-snapshot", goal: "question", progress }, generatedAt: at,
      events: [{ source: "zcode-hook", payload: { session_id: "z", hook_event_name: "Stop", last_assistant_message: sourceReply } }],
      git: { available: false, error: "not git" }, taskDir: "/state/task-snapshot" });
    assert.ok(context.includes(at));
    assert.match(context, /快照，非实时状态/);
    assert.match(context, /原会话陈述，非独立核验结论/);
    assert.match(context, /不能据此确认历史待办为空/);
    assert.ok(context.includes(sourceReply)); // Preserve the source, qualify its evidentiary status.
    assert.doesNotMatch(context, /当前登记项中无未完成工作/);
  }
});

test("stopped-turn snapshots retain their timestamp but old write entries fail; idle refresh backs up and removes the lease", async t => {
  const { store, a, auto, send } = await fixture(t);
  await send(a, "codex", "c", "UserPromptSubmit", { prompt: "Explain project" });
  const state = await autoStatus(store.root, a.cwd);
  const file = store.contextPath(a.id);
  const snapshot = await fs.readFile(file, "utf8");
  assert.match(snapshot, /快照，非实时状态/);
  assert.ok(snapshot.includes(state.owner.lease));
  await send(a, "codex", "c", "Stop", { last_assistant_message: "It is a sample project." });
  assert.equal(await fs.readFile(file, "utf8"), snapshot);
  const status = await auto.taskState(a.cwd);
  assert.equal(status.identity.owner.active, false);
  assert.equal(status.progressAssessment, "uninitialized");
  assert.ok(Number.isFinite(Date.parse(status.observedAt)));
  await assert.rejects(auto.updateProgress({ cwd: a.cwd, lease: state.owner.lease, revision: 0, patch }), /轮次/);
  const before = await autoStatus(store.root, a.cwd);
  const refreshed = await auto.refreshContext(a.id);
  assert.equal(await fs.readFile(refreshed.backup, "utf8"), snapshot);
  const refreshedText = await fs.readFile(file, "utf8");
  assert.match(refreshedText, /codex \(空闲\)/);
  assert.doesNotMatch(refreshedText, /--lease/);
  assert.deepEqual(await autoStatus(store.root, a.cwd), before);
});

test("development -> ordinary question -> restart -> other harness preserves pending work and isolates a parallel task", async t => {
  const { store, a, b, auto, send } = await fixture(t);
  await send(a, "codex", "a-c", "UserPromptSubmit", { prompt: "Implement login" });
  const initial = await autoStatus(store.root, a.cwd);
  await auto.updateProgress({ cwd: a.cwd, lease: initial.owner.lease, revision: 0, patch });
  await send(a, "codex", "a-c", "Stop", { last_assistant_message: "Implementation added; testing remains." });
  await send(a, "codex", "a-c", "UserPromptSubmit", { prompt: "What does the project do?" });
  await send(a, "codex", "a-c", "Stop", { last_assistant_message: "It is a business API backend." });
  await send(b, "codex", "b-c", "UserPromptSubmit", { prompt: "Implement report" });
  const bState = await autoStatus(store.root, b.cwd);
  await auto.updateProgress({ cwd: b.cwd, lease: bState.owner.lease, revision: 0,
    patch: { items: [{ id: "report", kind: "work", text: "REPORT_PENDING", status: "in_progress" }] } });
  await send(b, "codex", "b-c", "PreToolUse", { tool_name: "Bash", tool_use_id: "report-tool" });
  const bBefore = await autoStatus(store.root, b.cwd);
  const bTask = await store.require(b.id);
  for (let i = 0; i < 205; i++) await store.appendEvent(a.id, { type: "noise", index: i });
  const restarted = new AutoHandoff({ root: store.root });
  const response = await restarted.handle("zcode", { cwd: a.cwd, session_id: "a-z", hook_event_name: "UserPromptSubmit", prompt: "Continue the task" });
  const context = response.hookSpecificOutput.additionalContext;
  assert.match(context, /LOGIN_PENDING/);
  assert.match(context, /business API backend/);
  assert.match(context, /Preserve response fields/);
  assert.doesNotMatch(context, /REPORT_PENDING/);
  assert.match(context, /上一轮问答完成不代表开发完成/);
  assert.equal((await store.require(a.id)).progress.revision, 1);
  assert.deepEqual(await autoStatus(store.root, b.cwd), bBefore);
  assert.deepEqual(await store.require(b.id), bTask);
  await send(a, "zcode", "a-z", "Stop");
  assert.equal((await store.require(a.id)).status, "idle");
  assert.ok(hasPendingWork((await store.require(a.id)).progress));
});

test("lease and revision checks reject stale sessions, closed turns, and concurrent lost updates", async t => {
  const { store, a, b, auto, send } = await fixture(t);
  await send(a, "codex", "same-session", "UserPromptSubmit", { prompt: "work" });
  const firstLease = (await autoStatus(store.root, a.cwd)).owner.lease;
  await auto.updateProgress({ cwd: a.cwd, lease: firstLease, revision: 0, patch });
  await assert.rejects(auto.updateProgress({ cwd: a.cwd, lease: firstLease, revision: 0, patch }), /版本/);
  await assert.rejects(auto.updateProgress({ cwd: b.cwd, lease: firstLease, revision: 0, patch }), /执行权/);
  await send(a, "codex", "same-session", "Stop");
  await assert.rejects(auto.updateProgress({ cwd: a.cwd, lease: firstLease, revision: 1, patch }), /轮次/);
  await send(a, "codex", "same-session", "UserPromptSubmit", { prompt: "continue" });
  await assert.rejects(auto.updateProgress({ cwd: a.cwd, lease: firstLease, revision: 1, patch }), /执行权/);
  const lease = (await autoStatus(store.root, a.cwd)).owner.lease;
  const results = await Promise.allSettled([1, 2].map(n => auto.updateProgress({ cwd: a.cwd, lease, revision: 1, patch: { title: `Title ${n}` } })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await store.require(a.id)).progress.revision, 2);
  const before = await store.require(a.id);
  await assert.rejects(auto.updateProgress({ cwd: a.cwd, lease, revision: 2, patch: { items: Array(101).fill(patch.items[0]) } }), /100/);
  assert.deepEqual(await store.require(a.id), before);
});

test("pending transfer fences progress writes while leaving saved pending work intact", async t => {
  const { store, a, auto, send } = await fixture(t);
  await send(a, "codex", "c", "UserPromptSubmit", { prompt: "work" });
  const lease = (await autoStatus(store.root, a.cwd)).owner.lease;
  await auto.updateProgress({ cwd: a.cwd, lease, revision: 0, patch });
  const transfer = send(a, "zcode", "z", "UserPromptSubmit", { prompt: "continue" });
  for (let i = 0; i < 30 && !(await autoStatus(store.root, a.cwd)).pending; i++) await delay(5);
  assert.ok((await autoStatus(store.root, a.cwd)).pending);
  await assert.rejects(auto.updateProgress({ cwd: a.cwd, lease, revision: 1, patch: { title: "stale" } }), /交接/);
  await send(a, "codex", "c", "Stop");
  assert.match((await transfer).hookSpecificOutput.additionalContext, /LOGIN_PENDING/);
});

test("session-start and status identify the worktree without claiming ownership; CLI updates persist to the same task", async t => {
  const { dir, repo, store, a, b, auto, send } = await fixture(t);
  const cli = new URL("../src/cli.mjs", import.meta.url).pathname;
  const run = (args, cwd = a.cwd) => spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, HARNESS_SUPERVISOR_HOME: store.root }, encoding: "utf8" });
  await send(a, "codex", "a-c", "UserPromptSubmit", { prompt: "work" });
  const before = await autoStatus(store.root, a.cwd);
  const opened = await send(a, "zcode", "a-z", "SessionStart");
  assert.ok(opened.hookSpecificOutput.additionalContext.includes(a.cwd));
  assert.ok(opened.hookSpecificOutput.additionalContext.includes(a.worktree.branch));
  assert.deepEqual(await autoStatus(store.root, a.cwd), before);
  const sub = path.join(a.cwd, "src"); await fs.mkdir(sub);
  const alias = path.join(dir, "alias"); await fs.symlink(sub, alias, "dir");
  const output = run(["status", "--json"], alias);
  assert.equal(output.status, 0, output.stderr);
  const report = JSON.parse(output.stdout);
  assert.equal(report.current.taskId, a.id);
  assert.equal(report.current.owner.sessionId, "a-c");
  assert.deepEqual(new Set(report.tasks.map(task => task.taskId)), new Set([a.id, b.id]));
  assert.equal((await workspaceStatus(store, repo)).current, null);
  const input = path.join(dir, "patch.json"); await fs.writeFile(input, JSON.stringify(patch));
  const updated = run(["task-state", "--cwd", alias, "--update", input, "--lease", before.owner.lease, "--revision", "0"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout), { taskId: a.id, revision: 1 });
  const read = run(["task-state", "--cwd", alias]);
  assert.ok(hasPendingWork(JSON.parse(read.stdout).progress));
  assert.deepEqual(await autoStatus(store.root, a.cwd), before);
  assert.equal((await store.require(b.id)).progress, undefined);
  await send(a, "codex", "a-c", "Stop");
  const stale = run(["task-state", "--cwd", alias, "--update", input, "--lease", before.owner.lease, "--revision", "1"]);
  assert.equal(stale.status, 1);
});

test("large progress stays bounded, signals omitted items, and prioritizes blockers without dropping stored work", () => {
  const items = Array.from({ length: 80 }, (_, n) => ({ id: `todo-${n}`, kind: "work", status: "pending", text: `${n} 中文😀`.repeat(30) }));
  items.push({ id: "blocker", kind: "work", status: "blocked", text: "BLOCKER_REQUIRED" });
  const progress = mergeProgress(undefined, { items }, author);
  const task = { id: "task-large", cwd: "/repo", goal: "continue", progress };
  const context = buildHandoffContext({ task, events: [], git: { available: false, error: "not git" }, taskDir: "/state/task-large", progressCommand: { read: "node cli task-state", update: "node cli task-state --update <JSON-file>" } });
  assert.ok(Buffer.byteLength(context) <= MAX_CONTEXT_BYTES);
  assert.match(context, /BLOCKER_REQUIRED/);
  assert.match(context, /项未在摘要展开/);
  assert.match(context, /node cli task-state/);
  assert.doesNotMatch(context, /\uFFFD/);
  assert.equal(progress.items.length, 81);
});

test("project status includes older ordinary-directory tasks without assigning their newer session owner", async t => {
  const { dir, repo, store, auto } = await fixture(t);
  const old = await store.create({ cwd: repo, goal: "old task", primary: "codex" });
  await enableWorkspace(store.root, repo);
  await auto.handle("codex", { cwd: repo, session_id: "current", hook_event_name: "UserPromptSubmit", prompt: "new task" });
  const current = await autoStatus(store.root, repo);
  const report = await workspaceStatus(store, dir, { repo });
  assert.equal(report.current, null);
  assert.equal(report.tasks.find(task => task.taskId === old.id).owner, null);
  assert.equal(report.tasks.find(task => task.taskId === current.taskId).owner.sessionId, "current");
});

test("long current requests and durable state retain the latest reply tail with real update command overhead", () => {
  const progress = mergeProgress(undefined, { goal: "目标".repeat(150), items: Array.from({ length: 40 }, (_, n) => ({
    id: `i${n}`, kind: "work", status: "pending", text: "待办内容".repeat(30),
  })) }, author);
  const task = { id: "task-large", cwd: "/home/example/.harness-supervisor/worktrees/0123456789abcdef/login-task-20260912180000-3253be50",
    goal: "长任务目标".repeat(1000), worktree: {}, progress };
  const event = (at, hook, payload) => ({ source: "codex-hook", at, payload: { session_id: "c", hook_event_name: hook, ...payload } });
  const context = buildHandoffContext({ task, target: "codex", taskDir: "/state/task-large", git: { available: false, error: "not git" },
    identity: { title: "任务", cwd: task.cwd, branch: "harness/task-large", worktree: true, owner: { harness: "codex", sessionId: "c", active: true } },
    progressCommand: new AutoHandoff({ root: "/home/example/.harness-supervisor" }).progressCommand(task, { lease: "01234567-8901-2345-6789-012345678901" }),
    events: [event("01", "UserPromptSubmit", { prompt: "Previous request".repeat(500) }),
      event("02", "Stop", { last_assistant_message: "LATEST_REPLY " + "很长的内容".repeat(300) + " END_PENDING" }),
      event("03", "UserPromptSubmit", { prompt: "CURRENT_REQUEST " + "继续".repeat(500) })],
  });
  assert.ok(Buffer.byteLength(context) <= MAX_CONTEXT_BYTES);
  for (const marker of ["CURRENT_REQUEST", "LATEST_REPLY", "END_PENDING", "--update <JSON-file>", "work/pending", "项未在摘要展开"]) assert.ok(context.includes(marker), marker);
});
