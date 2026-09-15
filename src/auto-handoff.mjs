import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { TaskStore } from "./store.mjs";
import { captureGitState } from "./git-state.mjs";
import { buildHandoffContext, isContextRead } from "./handoff-context.mjs";
import { completedTurns } from "./turn-checkpoint.mjs";
import { HARNESS_INTEGRATIONS, normalizeHookInput } from "./harness-integrations.mjs";
import { mergeProgress, progressAssessment } from "./task-progress.mjs";
import { taskIdentity, identityLine } from "./task-identity.mjs";
import { fileURLToPath } from "node:url";
import { stoppedPatchCalls, stoppedRejectedShellCalls } from "./tool-reconciliation.mjs";
import { readCodexToolCompletions } from "./codex-tool-completion.mjs";
import { refreshPassiveCheckpoint } from "./passive-checkpoint.mjs";
import { readCodeBuddyCancellations } from "./codebuddy-reconciliation.mjs";
import { readCompletedCodexTurn } from "./codex-turn-reconciliation.mjs";
import { activeJob, readJob } from "./task-jobs.mjs";

export async function autoDirectory(root, cwd) {
  const canonical = await fs.realpath(cwd);
  return path.join(root, "auto", crypto.createHash("sha256").update(canonical).digest("hex"));
}

async function read(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function write(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
}

// A short, cross-process transaction lock. Never reclaim a lock on a timer:
// elapsed time does not prove the previous process stopped writing.
export async function transaction(dir, fn) {
  const lock = path.join(dir, "transaction.lock");
  let handle;
  const deadline = Date.now() + 1800;
  while (!handle) {
    try { handle = await fs.open(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`交接状态忙或存在残留锁：${lock}`);
      await delay(25);
    }
  }
  try { return await fn(); }
  finally { await handle.close(); await fs.unlink(lock); }
}

export async function enableWorkspace(root, cwd, { taskId = null, scope = "exact" } = {}) {
  const canonical = await fs.realpath(cwd);
  const dir = await autoDirectory(root, canonical);
  await fs.mkdir(dir, { recursive: true });
  return transaction(dir, async () => {
    const file = path.join(dir, "state.json");
    const existing = await read(file);
    if (existing) {
      if (taskId && existing.taskId !== taskId) throw new Error("此目录已关联其他任务");
      return existing;
    }
    const key = path.basename(dir);
    for (const conflict of [path.join(root, "locks", `${key}.lock`), path.join(root, "bindings", `${key}.json`)]) {
      try { await fs.access(conflict); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw new Error(`先结束旧的命令行交接流程：${conflict}`);
    }
    const state = { version: 1, cwd: canonical, taskId, scope, owner: null, pending: null, tools: {}, revision: 0 };
    await write(file, state);
    return state;
  });
}

export async function autoStatus(root, cwd) {
  const dir = await resolveAutoDirectory(root, cwd);
  return dir ? read(path.join(dir, "state.json")) : null;
}

// Only registered task worktrees cover subdirectories. Never walk across a
// nested repository/worktree boundary into an unrelated task's registration.
async function resolveAutoDirectory(root, cwd) {
  const start = await fs.realpath(cwd);
  let current = start;
  while (true) {
    const dir = await autoDirectory(root, current);
    const state = await read(path.join(dir, "state.json"));
    if (state && (current === start || state.scope === "worktree")) return dir;
    try { await fs.lstat(path.join(current, ".git")); return null; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function closeWorkspaceTask(store, task) {
  const dir = await autoDirectory(store.root, task.cwd);
  return transaction(dir, async () => {
    const file = path.join(dir, "state.json");
    const state = await read(file);
    if (state?.taskId !== task.id) throw new Error("任务与 worktree 记录不一致");
    if (activeJob(await readJob(store, task.id))) throw new Error("后台任务仍在运行，不能关闭");
    if (state.owner?.active || state.pending || Object.keys(state.tools).length) throw new Error("任务仍在运行或等待交接，不能关闭");
    // Close the gate first so no new prompt can enter while the task is saved.
    state.closed = true;
    await write(file, state);
    const latest = await store.require(task.id);
    latest.status = "archived";
    latest.closedAt ??= new Date().toISOString();
    await store.save(latest);
    return latest;
  });
}

const sessionKey = (harness, input) => `${harness}:${input.session_id ?? input.sessionId}`;
const toolKey = (input) => String(input.tool_use_id ?? input.toolUseId ?? "unknown");
const hookName = (input) => input.hook_event_name ?? input.hookEventName;

export function denyHook(hook, reason) {
  if (hook === "PreToolUse") return { hookSpecificOutput: { hookEventName: hook, permissionDecision: "deny", permissionDecisionReason: reason } };
  if (hook === "PermissionRequest") return { hookSpecificOutput: { hookEventName: hook, decision: { behavior: "deny", message: reason } } };
  if (hook === "UserPromptSubmit") return { continue: false, decision: "block", reason, stopReason: reason };
  return {};
}

function contextOutput(hook, context) {
  let excerpt = context;
  while (Buffer.byteLength(JSON.stringify(excerpt)) > 22000) excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.8));
  return { hookSpecificOutput: { hookEventName: hook, additionalContext: excerpt } };
}

export class AutoHandoff {
  constructor({ root, waitMs = 45000 } = {}) {
    this.store = new TaskStore(root);
    this.waitMs = waitMs;
  }

  async handle(harness, input, { expectedOwner } = {}) {
    if (!Object.hasOwn(HARNESS_INTEGRATIONS, harness)) throw new Error("Unknown harness integration");
    if (!input.cwd || !(input.session_id ?? input.sessionId)) return null;
    const dir = await resolveAutoDirectory(this.store.root, input.cwd);
    if (!dir) return null;
    input = normalizeHookInput(harness, input);
    const hook = hookName(input);
    const key = sessionKey(harness, input);
    const request = crypto.randomUUID();
    const deadline = Date.now() + this.waitMs;
    let reconciliationAttempted = false;
    while (true) {
      const outcome = await transaction(dir, async () => {
        const file = path.join(dir, "state.json");
        const state = await read(file);
        if (state.taskId && ["UserPromptSubmit", "PreToolUse", "PermissionRequest"].includes(hook)) {
          const job = await readJob(this.store, state.taskId);
          if (activeJob(job) && !(process.env.HARNESS_RELAY_JOB_TASK === state.taskId
            && process.env.HARNESS_RELAY_JOB_TOKEN === job.token)) {
            return { output: denyHook(hook, "此 worktree 正由后台任务执行，请等待该任务结束。") };
          }
        }
        if (state.closed) return { output: denyHook(hook, "此任务已关闭，请为新任务创建独立 worktree。") };
        const owns = state.owner?.key === key;
        const sameTurn = !input.turn_id || !state.owner?.turnId || input.turn_id === state.owner.turnId;
        // SessionEnd in some CodeBuddy paths has no generation identity. It
        // cannot establish which resumed turn ended, so never release on it.
        if (harness === "codebuddy" && input.hook_event_name === "SessionEnd" && !input.turn_id) return { output: {} };
        // Opening a window or compacting a session must not steal execution.
        if (hook === "SessionStart") {
          if (!state.taskId) return { output: {} };
          const task = await this.store.require(state.taskId);
          const identity = taskIdentity(task, state);
          return { output: contextOutput(hook, `任务身份：${identityLine(identity)}\nTask ID: ${task.id}\n目录：${task.cwd}\n分支：${identity.branch ?? "未登记"}\n当前查看会话：${key}；执行权尚未因打开窗口而改变。首次回复用一行说明所属任务与目录；等待用户消息，不自行开始工作。`) };
        }
        if (hook === "UserPromptSubmit") {
          if (expectedOwner && (state.taskId !== expectedOwner.taskId || (state.owner?.key ?? null) !== expectedOwner.key
            || (state.owner?.turnId ?? null) !== expectedOwner.turnId)) {
            return { output: denyHook(hook, "意图判断期间任务已变化，请重新判断后再接续。") };
          }
          if (!reconciliationAttempted) {
            reconciliationAttempted = true;
            if (await this.reconcileCodexTools(state)) await write(file, state);
            if (await this.reconcileCodexTurn(state)) await write(file, state);
            if (await this.reconcileCodeBuddyTools(state)) await write(file, state);
            if (await this.reconcileStoppedTools(state)) await write(file, state);
          }
          if (state.pending && state.pending.expires < Date.now()) state.pending = null;
          if (state.pending && state.pending.request !== request) {
            return { output: denyHook(hook, "已有另一个会话等待交接；本次请求未取得执行权。") };
          }
          if ((state.owner?.active && !owns) || Object.keys(state.tools).length > 0) {
            if (!state.pending) {
              state.pending = { key, request, expires: deadline };
              await write(file, state);
            }
            if (Date.now() >= deadline) {
              state.pending = null;
              await write(file, state);
              const reason = !state.owner?.active && Object.keys(state.tools).length
                ? `会话已停止，但仍有 ${Object.keys(state.tools).length} 个工具未确认结束；交接等待超时，本次消息未执行。需核对工具完成事件。`
                : "旧会话尚未确认停止，交接等待超时；本次消息未执行。旧会话结束后可再次发送普通消息。";
              return { output: denyHook(hook, reason) };
            }
            return { wait: true };
          }
          if (!state.taskId) {
            const task = await this.store.create({ goal: input.prompt ?? "继续当前项目任务", cwd: state.cwd, primary: harness, fallback: null });
            state.taskId = task.id;
          }
          const task = await this.store.require(state.taskId);
          const previous = state.owner?.key ?? null;
          const passive = await refreshPassiveCheckpoint(this.store, task.id);
          const promptAt = await this.record(task.id, harness, input);
          const events = await this.store.readEvents(task.id, { limit: 200 });
          state.checkpoints = completedTurns(events, state.checkpoints);
          const git = await captureGitState(state.cwd);
          const nextOwner = { key, harness, sessionId: input.session_id ?? input.sessionId, turnId: input.turn_id ?? null, active: true, prompt: redact(input.prompt ?? ""), startAt: promptAt, lease: crypto.randomUUID() };
          const context = buildHandoffContext({ task, events, git, passive, taskDir: this.store.taskDir(task.id), target: harness, auto: true, checkpoints: state.checkpoints,
            identity: taskIdentity(task, { ...state, owner: nextOwner }),
            transition: previous !== key ? { from: state.owner?.harness ?? null, to: harness } : null,
            progressCommand: this.progressCommand(task, nextOwner) });
          await this.store.writeContext(task.id, context);
          state.owner = nextOwner;
          state.pending = null;
          state.revision += 1;
          task.owner = harness;
          task.status = "running";
          task.sessions[harness] = state.owner.sessionId;
          await this.store.save(task);
          await this.store.appendEvent(task.id, { type: "task.auto_handoff", from: previous, to: key, revision: state.revision });
          await write(file, state);
          return { output: contextOutput(hook, context) };
        }
        if (!state.taskId) return { output: denyHook(hook, "请先在启用 Hook 的新会话发送消息，建立任务关联。") };
        if (hook === "PreToolUse" || hook === "PermissionRequest") {
          if (!owns || !sameTurn || !state.owner.active || state.pending) {
            if (hook === "PermissionRequest" && owns && sameTurn) {
              delete state.tools[toolKey(input)];
              await write(file, state);
            }
            return { output: denyHook(hook, "执行权已转交或正在交接。请结束本轮，不再执行工具。") };
          }
          if (/^(Agent|Task|spawn_agent)$/i.test(input.tool_name ?? "")) {
            return { output: denyHook(hook, "自动交接当前仅跟踪主会话，请在主会话完成工作。") };
          }
          if (hook === "PreToolUse") {
            if (!(input.tool_use_id ?? input.toolUseId)) return { output: denyHook(hook, "客户端未提供工具调用编号，无法安全跟踪交接。") };
            state.tools[toolKey(input)] = { key, turnId: input.turn_id ?? null, contextRead: isContextRead(input, this.store.taskDir(state.taskId)) };
            await this.record(state.taskId, harness, input);
            await write(file, state);
          }
          return { output: {} };
        }
        if (!owns || !sameTurn) return { output: {} };
        const recordedAt = await this.record(state.taskId, harness, input, state.tools[toolKey(input)]?.contextRead);
        if (hook === "PostToolUse" || hook === "PostToolUseFailure") {
          delete state.tools[toolKey(input)];
        }
        if (["Stop", "Interrupt", "SessionEnd"].includes(hook)) {
          if (hook === "Stop") {
            state.checkpoints ??= {};
            state.checkpoints[harness] = {
              harness, sessionId: state.owner.sessionId, turnId: state.owner.turnId,
              request: state.owner.prompt ?? "", startAt: state.owner.startAt ?? null,
              reply: redact(input.last_assistant_message ?? input.lastAssistantMessage ?? ""), at: recordedAt, ended: true,
            };
          }
          state.owner.active = false;
          if (hook === "Stop") await this.reconcileStoppedTools(state);
          const task = await this.store.require(state.taskId);
          task.status = Object.keys(state.tools).length ? "waiting_tools" : "idle";
          await this.store.save(task);
        }
        await write(file, state);
        // Stop requests are cooperative: never claim another client's process was killed.
        const note = state.pending ? "另一个会话正在接管此任务，请结束本轮，不要再调用工具。" : "";
        const output = note && hook === "PostToolUse" ? contextOutput(hook, note) : {};
        if (note && hook === "PostToolUse" && HARNESS_INTEGRATIONS[harness].stopAfterTool) {
          output.continue = false;
          output.stopReason = note;
        }
        return { output };
      });
      if (!outcome.wait) return outcome.output;
      await delay(100);
    }
  }

  async reconcileStoppedTools(state) {
    if (!state.taskId || state.owner?.active || !Object.keys(state.tools).length) return false;
    const events = await this.store.readEvents(state.taskId, { limit: 200 });
    const resolved = [...stoppedPatchCalls(state, events), ...await stoppedRejectedShellCalls(state, events)];
    if (!resolved.length) return false;
    await this.store.appendEvent(state.taskId, {
      type: "task.tools_reconciled", sessionId: state.owner.sessionId,
      turnId: state.owner.turnId, tools: resolved,
    });
    for (const tool of resolved) delete state.tools[tool.id];
    const task = await this.store.require(state.taskId);
    task.status = Object.keys(state.tools).length ? "waiting_tools" : "idle";
    await this.store.save(task);
    return true;
  }

  async reconcileCodexTurn(state) {
    if (!state.taskId || state.owner?.harness !== "codex") return false;
    const checkpoint = state.checkpoints?.codex;
    if (checkpoint?.nativeEnd && checkpoint.sessionId === state.owner.sessionId && checkpoint.turnId === state.owner.turnId) return false;
    const events = await this.store.readEvents(state.taskId, { limit: 200 });
    const completed = await readCompletedCodexTurn(state, events);
    if (!completed) return false;
    state.owner.active = false;
    // Reuse only the synchronous-patch rule. A completed turn does not prove
    // Bash or MCP background work has stopped. This local projection is never
    // persisted as a fabricated Stop hook; the journal names the native source.
    const resolved = stoppedPatchCalls(state, [...events, { at: completed.at, source: "codex-hook", payload: {
      hook_event_name: "Stop", session_id: completed.sessionId, turn_id: completed.turnId,
    } }]).filter(tool => {
      const pre = events.findLast(e => e.source === "codex-hook" && e.payload?.session_id === completed.sessionId
        && e.payload?.turn_id === completed.turnId && e.payload?.hook_event_name === "PreToolUse"
        && (e.payload.tool_use_id ?? e.payload.toolUseId) === tool.id);
      return Date.parse(pre?.at) <= Date.parse(completed.at);
    }).map(tool => ({ ...tool, reason: "native_completed_synchronous_patch" }));
    await this.store.appendEvent(state.taskId, { type: "task.native_turn_reconciled", ...completed, reply: redact(completed.reply), tools: resolved });
    for (const tool of resolved) delete state.tools[tool.id];
    state.checkpoints ??= {};
    state.checkpoints.codex = { harness: "codex", sessionId: completed.sessionId, turnId: completed.turnId,
      request: state.owner.prompt ?? "", startAt: state.owner.startAt, at: completed.at,
      reply: redact(completed.reply), ended: true, nativeEnd: true };
    const task = await this.store.require(state.taskId);
    task.status = Object.keys(state.tools).length ? "waiting_tools" : "idle";
    await this.store.save(task);
    return true;
  }

  async reconcileNativeTurn(id) {
    const task = await this.store.require(id);
    const dir = await autoDirectory(this.store.root, task.cwd);
    return transaction(dir, async () => {
      const file = path.join(dir, "state.json");
      const state = await read(file);
      if (state?.taskId !== id || (state.pending && !(state.pending.expires < Date.now()))) throw new Error("任务已变化或正在交接，不能修复轮次记录");
      const expiredPending = !!state.pending;
      if (expiredPending) state.pending = null;
      const toolsChanged = await this.reconcileCodexTools(state);
      const turnChanged = await this.reconcileCodexTurn(state);
      const changed = toolsChanged || turnChanged;
      if (changed || expiredPending) await write(file, state);
      return { changed, active: state.owner?.active, remainingTools: Object.keys(state.tools).length };
    });
  }

  async reconcileCodexTools(state) {
    if (!state.taskId || state.owner?.harness !== "codex" || !Object.keys(state.tools).length) return false;
    const events = await this.store.readEvents(state.taskId, { limit: 200 });
    const resolved = await readCodexToolCompletions(state, events);
    if (!resolved.length) return false;
    await this.store.appendEvent(state.taskId, { type: "task.tools_reconciled", sessionId: state.owner.sessionId,
      turnId: state.owner.turnId, tools: resolved });
    for (const tool of resolved) delete state.tools[tool.id];
    const task = await this.store.require(state.taskId);
    task.status = Object.keys(state.tools).length ? "waiting_tools" : state.owner.active ? "running" : "idle";
    await this.store.save(task);
    return true;
  }

  async reconcileCodeBuddyTools(state) {
    if (!state.taskId || state.owner?.harness !== "codebuddy" || !Object.keys(state.tools).length) return false;
    const events = await this.store.readEvents(state.taskId, { limit: 200 });
    const resolved = await readCodeBuddyCancellations(state, events);
    if (!resolved.length) return false;
    await this.store.appendEvent(state.taskId, { type: "task.tools_reconciled", sessionId: state.owner.sessionId,
      turnId: state.owner.turnId, tools: resolved });
    for (const item of resolved) delete state.tools[item.id];
    // Tool cancellation proves only that call did not execute. Keep an active
    // owner fenced from OTHER sessions until an end event or same-session next
    // prompt establishes a new turn. Never infer whole-turn completion here.
    const task = await this.store.require(state.taskId);
    task.status = Object.keys(state.tools).length ? "waiting_tools" : state.owner.active ? "running" : "idle";
    await this.store.save(task);
    return true;
  }

  async reconcileCancelledTools(id) {
    const task = await this.store.require(id);
    const dir = await autoDirectory(this.store.root, task.cwd);
    return transaction(dir, async () => {
      const file = path.join(dir, "state.json");
      const state = await read(file);
      if (state?.taskId !== id || state.pending) throw new Error("任务已变化或正在交接，不能修复工具记录");
      const changed = await this.reconcileCodeBuddyTools(state);
      if (changed) await write(file, state);
      return { changed, remainingTools: Object.keys(state.tools).length };
    });
  }

  async reconcileTools(id) {
    const task = await this.store.require(id);
    const dir = await autoDirectory(this.store.root, task.cwd);
    return transaction(dir, async () => {
      const file = path.join(dir, "state.json");
      const state = await read(file);
      if (state?.taskId !== id || state.owner?.active || state.pending) throw new Error("任务仍在运行或等待交接，不能修复工具记录");
      const changed = await this.reconcileStoppedTools(state);
      if (changed) await write(file, state);
      return { changed, remainingTools: Object.keys(state.tools).length };
    });
  }

  // Explicit recovery for a conversation that predates workspace registration.
  // This imports source statements, not synthetic hooks or execution ownership.
  async importCompletedHandoff({ cwd, goal, checkpoint, sourcePath, sourceText }) {
    if (!checkpoint || !Object.hasOwn(HARNESS_INTEGRATIONS, checkpoint.harness)
      || !checkpoint.sessionId || !checkpoint.turnId || checkpoint.ended !== true
      || !Number.isFinite(Date.parse(checkpoint.at)) || !Number.isFinite(Date.parse(checkpoint.startAt))
      || Date.parse(checkpoint.startAt) > Date.parse(checkpoint.at)
      || typeof checkpoint.request !== "string" || typeof checkpoint.reply !== "string"
      || typeof goal !== "string" || !goal.trim() || typeof sourceText !== "string"
      || typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) {
      throw new Error("导入需要已结束轮次的请求、回复、来源及时间记录");
    }
    const canonical = await fs.realpath(cwd);
    const existing = await resolveAutoDirectory(this.store.root, canonical);
    if (existing) throw new Error("此目录已登记任务；不能用历史导入覆盖现有交接");
    await enableWorkspace(this.store.root, canonical);
    const dir = await autoDirectory(this.store.root, canonical);
    return transaction(dir, async () => {
      const file = path.join(dir, "state.json");
      const state = await read(file);
      if (state.taskId || state.owner || state.pending || state.closed || Object.keys(state.tools).length) {
        throw new Error("目录已开始工作；不能导入历史会话");
      }
      const task = await this.store.create({ goal, cwd: canonical, primary: checkpoint.harness });
      const sourceFile = path.join(this.store.taskDir(task.id), "imported-handoff.md");
      await fs.writeFile(sourceFile, sourceText, { mode: 0o600, flag: "wx" });
      const imported = { ...redact(checkpoint), imported: true, sourcePath, sourceFile };
      state.taskId = task.id;
      state.checkpoints = { [checkpoint.harness]: imported };
      task.status = "idle";
      task.sessions[checkpoint.harness] = checkpoint.sessionId;
      await this.store.appendEvent(task.id, { type: "task.handoff_imported", checkpoint: imported, sourcePath, sourceFile });
      await this.store.save(task);
      const context = buildHandoffContext({ task, events: [], git: await captureGitState(canonical),
        taskDir: this.store.taskDir(task.id), auto: true, checkpoints: state.checkpoints,
        identity: taskIdentity(task, state) });
      await this.store.writeContext(task.id, context);
      await write(file, state);
      return { taskId: task.id, cwd: canonical, contextPath: this.store.contextPath(task.id), sourceFile };
    });
  }

  progressCommand(task, owner) {
    const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
    const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const readCommand = `env HARNESS_RELAY_HOME=${quote(this.store.root)} ${quote(process.execPath)} ${quote(cli)} task-state --cwd ${quote(task.cwd)}`;
    return { read: readCommand, update: `${readCommand} --lease ${quote(owner.lease)} --revision ${task.progress?.revision ?? 0} --update <JSON-file>` };
  }

  async taskState(cwd) {
    const state = await autoStatus(this.store.root, cwd);
    if (!state?.taskId) throw new Error("此目录尚未关联任务");
    const task = await this.store.require(state.taskId);
    return { observedAt: new Date().toISOString(), identity: taskIdentity(task, state), progressAssessment: progressAssessment(task.progress), progress: task.progress ?? { version: 1, revision: 0, items: [] } };
  }

  async updateProgress({ cwd, lease, revision, patch }) {
    const dir = await resolveAutoDirectory(this.store.root, cwd);
    if (!dir) throw new Error("此目录尚未关联任务");
    return transaction(dir, async () => {
      const state = await read(path.join(dir, "state.json"));
      if (state.closed || !state.taskId || !lease || state.owner?.lease !== lease || !state.owner.active || state.pending) {
        throw new Error("当前轮次已结束、执行权已变化或正在交接，不能更新任务状态");
      }
      const task = await this.store.require(state.taskId);
      if (!Number.isInteger(revision) || revision !== (task.progress?.revision ?? 0)) throw new Error("任务状态版本已变化；读取 task-state 后合并更新，不能覆盖新进展");
      const progress = mergeProgress(task.progress, patch, {
        harness: state.owner.harness, sessionId: state.owner.sessionId, turnId: state.owner.turnId, generation: state.revision,
      });
      for (const field of ["title", "goal"]) if (progress[field]) progress[field] = redact(progress[field]);
      for (const item of progress.items) {
        item.text = redact(item.text);
        if (item.evidence) item.evidence = redact(item.evidence);
      }
      // task.json is the authoritative atomic checkpoint, including provenance.
      task.progress = progress;
      await this.store.save(task);
      return { taskId: task.id, revision: progress.revision };
    });
  }

  async refreshContext(id) {
    const initial = await this.store.require(id);
    const dir = await autoDirectory(this.store.root, initial.cwd);
    return transaction(dir, async () => {
      const state = await read(path.join(dir, "state.json"));
      if (state?.taskId !== id) throw new Error("任务不是此目录当前关联的自动任务");
      if (state.owner?.active || state.pending || Object.keys(state.tools).length) throw new Error("任务仍在运行或等待交接，不能重建摘要");
      const task = await this.store.require(id);
      const [events, git] = await Promise.all([this.store.readEvents(id, { limit: 200 }), captureGitState(task.cwd)]);
      const passive = await refreshPassiveCheckpoint(this.store, id);
      const context = buildHandoffContext({ task, events, git, passive, taskDir: this.store.taskDir(id), auto: true, checkpoints: state.checkpoints, identity: taskIdentity(task, state) });
      const file = this.store.contextPath(id);
      const backup = `${file}.backup-${crypto.randomUUID()}`;
      await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
      await this.store.writeContext(id, context);
      return { path: file, backup, bytes: Buffer.byteLength(context) };
    });
  }

  async record(id, harness, input, contextRead = false) {
    const at = new Date().toISOString();
    const payload = redact(input);
    if (contextRead || isContextRead(input, this.store.taskDir(id))) {
      // Keep the lifecycle event, but never re-ingest a handoff document's body.
      for (const field of ["tool_response", "toolResponse", "tool_input", "toolInput"]) delete payload[field];
      payload.handoff_content_omitted = true;
    }
    await fs.appendFile(this.store.externalEventsPath(id), JSON.stringify({ at, source: `${harness}-hook`, payload }) + "\n", { mode: 0o600 });
    await refreshPassiveCheckpoint(this.store, id);
    const transcript = input.transcript_path ?? input.transcriptPath;
    if (transcript) {
      try {
        const handle = await fs.open(transcript, "r");
        let data;
        try {
          const { size } = await handle.stat();
          const buffer = Buffer.alloc(Math.min(size, 1000000));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
          data = buffer.subarray(0, bytesRead).toString("utf8");
        } finally { await handle.close(); }
        const native = path.join(this.store.taskDir(id), "native");
        await fs.mkdir(native, { recursive: true });
        const session = crypto.createHash("sha256").update(sessionKey(harness, input)).digest("hex");
        await fs.writeFile(path.join(native, `${harness}-${session}.jsonl`), data.split("\n").map(line => {
          try { return JSON.stringify(redact(JSON.parse(line))); } catch { return String(redact(line)); }
        }).join("\n"), { mode: 0o600 });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return at;
  }
}

export function redact(value, key = "") {
  if (/api.?key|authorization|password|secret|access.?token|refresh.?token/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/\bsk-[\w-]{12,}\b/g, "[REDACTED]").slice(0, 15000);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => redact(v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}
