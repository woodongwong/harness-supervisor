import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { WorktreeTasks } from "../src/worktree-tasks.mjs";
import { TaskStore } from "../src/store.mjs";
import { AutoHandoff, autoStatus } from "../src/auto-handoff.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-worktrees-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  await fs.mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  await fs.writeFile(path.join(repo, "shared.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "shared.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  const store = new TaskStore(path.join(dir, "state"));
  return { dir, repo, store, tasks: new WorktreeTasks({ store }), auto: new AutoHandoff({ root: store.root, waitMs: 100 }) };
}

test("parallel task worktrees isolate files, sessions and handoffs; source dirty files are preserved", async t => {
  const { repo, store, tasks, auto } = await fixture(t);
  await fs.writeFile(path.join(repo, "shared.txt"), "user uncommitted work\n");
  const [a, b] = await Promise.all([
    tasks.create({ repo, goal: "task A", name: "login" }),
    tasks.create({ repo, goal: "task B", name: "report" }),
  ]);
  assert.notEqual(a.cwd, b.cwd);
  assert.notEqual(a.worktree.branch, b.worktree.branch);
  assert.equal(await fs.readFile(path.join(a.cwd, "shared.txt"), "utf8"), "base\n");
  assert.equal(await fs.readFile(path.join(repo, "shared.txt"), "utf8"), "user uncommitted work\n");
  const send = (task, harness, event, extra = {}) => auto.handle(harness, { cwd: task.cwd, session_id: `${task.id}-${harness}`, hook_event_name: event, ...extra });
  const outputs = await Promise.all([
    send(a, "codex", "UserPromptSubmit", { prompt: "implement A" }),
    send(b, "codex", "UserPromptSubmit", { prompt: "implement B" }),
  ]);
  assert.match(outputs[0].hookSpecificOutput.additionalContext, /task A/);
  assert.doesNotMatch(outputs[0].hookSpecificOutput.additionalContext, /task B/);
  await Promise.all([
    fs.writeFile(path.join(a.cwd, "shared.txt"), "A edit\n"),
    fs.writeFile(path.join(b.cwd, "shared.txt"), "B edit\n"),
  ]);
  await send(b, "codex", "PreToolUse", { tool_name: "Bash", tool_use_id: "running" });
  await send(a, "codex", "Stop", { last_assistant_message: "A done" });
  const bBefore = await autoStatus(store.root, b.cwd);
  const handoff = await send(a, "zcode", "UserPromptSubmit", { prompt: "review A" });
  assert.match(handoff.hookSpecificOutput.additionalContext, /A done/);
  assert.deepEqual(await autoStatus(store.root, b.cwd), bBefore);
  assert.equal((await autoStatus(store.root, a.cwd)).taskId, a.id);
  assert.equal(await fs.readFile(path.join(a.cwd, "shared.txt"), "utf8"), "A edit\n");
  assert.equal(await fs.readFile(path.join(b.cwd, "shared.txt"), "utf8"), "B edit\n");
  assert.equal((await tasks.list(a.cwd)).length, 2);
});

test("subdirectories and symlinks resolve to their task but nested repositories do not", async t => {
  const { repo, store, tasks, auto } = await fixture(t);
  const task = await tasks.create({ repo, goal: "nested" });
  const sub = path.join(task.cwd, "src"); await fs.mkdir(sub);
  const link = path.join(task.cwd, "linked"); await fs.symlink(sub, link, "dir");
  assert.equal((await autoStatus(store.root, link)).taskId, task.id);
  const output = await auto.handle("codex", { cwd: sub, session_id: "sub", hook_event_name: "UserPromptSubmit", prompt: "continue" });
  assert.match(output.hookSpecificOutput.additionalContext, /nested/);
  const legacy = await store.create({ cwd: sub, goal: "bypass", primary: "codex" });
  await assert.rejects(store.withTaskLock(legacy.id, async () => {}), /不能混用/);
  const nested = path.join(task.cwd, "vendor-repo"); await fs.mkdir(nested);
  execFileSync("git", ["init", "-q", nested]);
  assert.equal(await autoStatus(store.root, nested), null);
});

test("closing refuses active tasks, retains uncommitted changes, and blocks later prompts", async t => {
  const { repo, tasks, auto } = await fixture(t);
  const task = await tasks.create({ repo, goal: "retain" });
  const input = { cwd: task.cwd, session_id: "one" };
  await auto.handle("codex", { ...input, hook_event_name: "UserPromptSubmit", prompt: "work" });
  await assert.rejects(tasks.close(task.id), /仍在运行/);
  await auto.handle("codex", { ...input, hook_event_name: "Stop" });
  await fs.writeFile(path.join(task.cwd, "new.txt"), "keep me");
  assert.equal((await tasks.close(task.id)).status, "archived");
  assert.equal(await fs.readFile(path.join(task.cwd, "new.txt"), "utf8"), "keep me");
  assert.equal((await auto.handle("zcode", { ...input, hook_event_name: "UserPromptSubmit", prompt: "work" })).continue, false);
  await assert.rejects(tasks.location(task.id), /已关闭/);
});

test("invalid base and non-repositories fail before creating task records", async t => {
  const { dir, repo, tasks } = await fixture(t);
  await assert.rejects(tasks.create({ repo: dir, goal: "bad" }), /Git 操作失败/);
  await assert.rejects(tasks.create({ repo, goal: "bad", base: "nonexistent-ref" }), /Git 操作失败/);
  assert.equal((await tasks.list()).length, 0);
});

test("open passes exact worktree directory to the client without starting a managed worker", async t => {
  const { repo, tasks } = await fixture(t);
  const task = await tasks.create({ repo, goal: "open" });
  for (const harness of ["codex", "zcode", "codebuddy"]) {
    let invocation;
    const result = await tasks.open(task.id, harness, { interactive: true, isTTY: true, spawnImpl: (binary, args, options) => {
      invocation = { binary, args, options };
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", 0, null));
      return child;
    } });
    assert.equal(result.code, 0);
    assert.equal(invocation.options.cwd, task.cwd);
    assert.deepEqual(invocation.args, harness === "codex" ? ["-C", task.cwd] : harness === "codebuddy" ? [] : [task.cwd]);
  }
});

test("CLI creates, lists and locates the same registered worktree task", async t => {
  const { repo, store } = await fixture(t);
  const cli = new URL("../src/cli.mjs", import.meta.url).pathname;
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, HARNESS_SUPERVISOR_HOME: store.root }, encoding: "utf8" });
  const created = run(["task-new", "--repo", repo, "--task", "CLI task", "--json"]);
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout);
  const plan = run(["task-open", task.id, "--in", "codex", "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).cwd, task.cwd);
  assert.deepEqual(JSON.parse(plan.stdout).args, ["-C", task.cwd]);
  const nested = run(["task-open", task.id, "--in", "codex", "--interactive"]);
  assert.notEqual(nested.status, 0);
  assert.match(nested.stderr, /交互客户端必须/);
  const listed = run(["task-list", "--repo", repo, "--json"]);
  assert.equal(JSON.parse(listed.stdout)[0].id, task.id);
  const location = run(["task-open", task.id]);
  assert.equal(location.stdout.trim(), task.cwd);
  assert.equal((await autoStatus(store.root, task.cwd)).taskId, task.id);
});

test("terminal launch returns on spawn without waiting for child close and preserves argv", async t => {
  const { repo, tasks, store } = await fixture(t);
  const task = await tasks.create({ repo, goal: "separate terminal" });
  const before = await autoStatus(store.root, task.cwd);
  let invocation, unref = false;
  const result = await tasks.open(task.id, "codex", { terminalArgs: ["example-terminal", "--"], spawnImpl: (bin, args, opts) => {
    invocation = { bin, args, opts };
    const child = new EventEmitter();
    child.unref = () => { unref = true; };
    setImmediate(() => child.emit("spawn"));
    return child;
  } });
  const plan = await tasks.launchPlan(task.id, "codex");
  assert.equal(result.launched, true);
  assert.equal(result.verifiedSession, false);
  assert.equal(unref, true);
  assert.deepEqual(invocation.args, ["--", plan.binary, ...plan.args]);
  assert.equal(invocation.opts.cwd, task.cwd);
  assert.equal(invocation.opts.detached, true);
  assert.equal(invocation.opts.stdio, "ignore");
  assert.deepEqual(await autoStatus(store.root, task.cwd), before);
  await assert.rejects(tasks.open(task.id, "codex"), /交互客户端必须/);
  await assert.rejects(tasks.open(task.id, "codex", { terminalArgs: [] }), /JSON/);
  await assert.rejects(tasks.open(task.id, "codex", { terminalArgs: ["missing"], spawnImpl: () => {
    const child = new EventEmitter(); setImmediate(() => child.emit("error", new Error("ENOENT"))); return child;
  } }), /ENOENT/);
});

test("launch instructions quote paths with spaces and shell syntax literally", async t => {
  const { dir, tasks } = await fixture(t);
  const cwd = path.join(dir, "repo's $(false) space");
  await fs.mkdir(cwd);
  // launchPlan uses validated task identity; isolate shell quoting from Git setup.
  tasks.location = async () => ({ id: "task-example", cwd });
  const plan = await tasks.launchPlan("task-example", "codebuddy");
  const cdPart = plan.command.slice(0, plan.command.indexOf(" && "));
  const actual = execFileSync("bash", ["-c", `${cdPart} && pwd`], { encoding: "utf8" }).trim();
  assert.equal(actual, cwd);
});
