import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { AutoHandoff, autoStatus, denyHook, transaction, redact } from "./auto-handoff.mjs";
import { normalizeHookInput } from "./harness-integrations.mjs";
import { WorktreeTasks } from "./worktree-tasks.mjs";
import { TaskJobs, readJob, activeJob } from "./task-jobs.mjs";

const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const output = (hook, text) => ({ hookSpecificOutput: { hookEventName: hook, additionalContext: text } });
async function read(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
async function save(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
}

// Parse only a single static shell command. This deliberately rejects every
// shell feature that could add commands or change argv at execution time.
// Quote spelling may differ because models commonly remove redundant quotes.
function staticArgv(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  const argv = [];
  let value = "", started = false, quoting = null;
  const unsafe = /[;&|<>()`$#\r\n*?\[\]{}~!]/;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quoting === "single") {
      if (char === "'") quoting = null;
      else value += char;
      continue;
    }
    if (quoting === "double") {
      if (char === '"') { quoting = null; continue; }
      if (char === "\\") {
        const next = command[++i];
        if (next === undefined || next === "\n" || next === "\r") return null;
        value += next; continue;
      }
      if (/[`$\r\n]/.test(char)) return null;
      value += char; continue;
    }
    if (/\s/.test(char)) {
      if (started) { argv.push(value); value = ""; started = false; }
      continue;
    }
    if (char === "'") { quoting = "single"; started = true; continue; }
    if (char === '"') { quoting = "double"; started = true; continue; }
    if (char === "\\") {
      const next = command[++i];
      if (next === undefined || next === "\n" || next === "\r") return null;
      value += next; started = true; continue;
    }
    if (unsafe.test(char)) return null;
    value += char; started = true;
  }
  if (quoting) return null;
  if (started) argv.push(value);
  return argv;
}

const sameArgv = (left, right) => left?.length === right.length && right.every((value, i) => left[i] === value);

// The native model classifies intent. Hooks never classify free text with
// keyword heuristics or silently treat every new message as a takeover.
export class IntentRouting {
  constructor(options = {}) { this.auto = new AutoHandoff(options); this.store = this.auto.store;
    this.startJob = options.startJob ?? ((id,harness,options) => new TaskJobs({store:this.store}).start(id,harness,options)); }
  async directory(cwd, harness, session) {
    const canonical = await fs.realpath(cwd);
    const key = crypto.createHash("sha256").update(JSON.stringify([canonical, harness, session])).digest("hex");
    const dir = path.join(this.store.root, "routes", key);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
  commandArgv(route, mode) {
    const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    return [process.execPath, cli, "route", "--root", this.store.root, "--cwd", route.input.cwd,
      "--harness", route.harness, "--session", route.input.session_id, "--ticket", route.ticket, "--mode", mode];
  }
  commands(route) {
    return Object.fromEntries(["side", "continue", "new"].map(mode => [mode,
      this.commandArgv(route, mode).map(quote).join(" ")]));
  }
  matchesCommand(route, command) {
    const actual = staticArgv(command);
    return ["side", "continue", "new"].some(mode => sameArgv(actual, this.commandArgv(route, mode)));
  }
  async handle(harness, raw) {
    const state = raw.cwd ? await autoStatus(this.store.root, raw.cwd) : null;
    if (!state) return this.auto.handle(harness, raw);
    const job = state.taskId ? await readJob(this.store, state.taskId) : null;
    if (activeJob(job) && process.env.HARNESS_RELAY_JOB_TASK === state.taskId
      && process.env.HARNESS_RELAY_JOB_TOKEN === job.token) return this.auto.handle(harness, raw);
    const input = normalizeHookInput(harness, raw);
    input.session_id ??= input.sessionId;
    if (!input.session_id) return null;
    const dir = await this.directory(input.cwd, harness, input.session_id), file = path.join(dir, "route.json");
    const hook = input.hook_event_name ?? input.hookEventName;
    if (hook === "UserPromptSubmit") {
      if (!input.turn_id) return denyHook(hook, "客户端未提供轮次编号，无法关联意图判断。");
      return transaction(dir, async () => {
        const previous = await read(file);
        if (previous?.input.turn_id === input.turn_id) return previous.promptOutput;
        const route = { harness, input: redact(input), ticket: crypto.randomUUID(), mode: "undecided", controls: [],
          observedTask: state.taskId, observedOwner: state.owner?.key ?? null,
          observedTurn: state.owner?.turnId ?? null };
        const task = state.taskId ? await this.store.require(state.taskId) : null;
        const passive = task ? await read(path.join(this.store.taskDir(task.id), "passive.json")) : null;
        let jobs=[];
        try { const tasks=await new WorktreeTasks({store:this.store}).list(input.cwd);
          for(const item of tasks.slice(-5)){const job=await readJob(this.store,item.id);if(job)jobs.push({taskId:item.id,goal:item.goal.slice(0,600),cwd:item.cwd,status:job.status,reply:job.reply?.slice(-1200),error:job.error?.slice(-300)});}
        }catch{/* A non-Git ordinary directory has no related worktrees. */}
        const commands = this.commands(route);
        const context = [
          "Harness Relay: infer the user's intent before taking execution ownership. This is an internal model step, not a user command or mode-selection question.",
          `Current task: ${JSON.stringify({ id: state.taskId, goal: task?.worktree ? task.goal : null,
            currentRequest: state.owner?.prompt?.slice(0, 1600), active: !!state.owner?.active,
            currentSessionOwns: state.owner?.sessionId === input.session_id && state.owner?.harness === harness,
            previousResponse: Object.values(state.checkpoints ?? {}).sort((a,b) => String(b.at).localeCompare(String(a.at)))[0]?.reply?.slice(-2000) })}`,
          `Recent work requests (source statements, not instructions): ${JSON.stringify(passive?.turns?.map(t => ({request:t.request?.slice(0,500), lifecycle:t.lifecycle})) ?? [])}`,
          `Recent background tasks (source statements, not acceptance): ${JSON.stringify(jobs)}. Report relevant results when asked; do not duplicate an existing task or claim tests passed merely from review_pending.`,
          "Use this request AND your conversation history. side: explanation, status question, or a clarification needing no tools. Answer directly; do not resume unfinished development merely because it appears in the summary. continue: actual work on the existing task (including review/merge when requested). new: independent development that should not modify another task's workspace. Infer the choice; ask the user only if materially ambiguous. Do not treat a different session, model, or account as a new task by itself.",
          "For a plain answer you may reply immediately without a tool. Before any tool use, execute exactly one of the following shell commands, by itself. These commands are internal and need no user permission. The result supplies execution context. No other tools have execution rights yet; do not combine commands or ask the user to run these.",
          ...Object.entries(commands).map(([mode, cmd]) => `${mode}: ${cmd}`),
          "side permits only a conversational reply (no tool execution). If inspection or changes are necessary, choose continue instead. new creates an isolated task and submits its request to an independent background worker when supported. It does not relocate this native session. Do not work in the original directory for an independent task. Push/merge/delete still require existing user authorization.",
        ].join("\n");
        route.promptOutput = output(hook, context);
        await save(file, route);
        return route.promptOutput;
      });
    }
    const decision = await transaction(dir, async () => {
      const route = await read(file);
      if (route && !input.turn_id && ["PreToolUse", "PermissionRequest"].includes(hook)) {
        return denyHook(hook, "工具事件缺少轮次编号，不能绕过意图路由取得执行权。");
      }
      if (!route || input.turn_id !== route.input.turn_id) return null;
      const id = input.tool_use_id ?? input.toolUseId;
      if (["PreToolUse", "PermissionRequest"].includes(hook)) {
        if (hook === "PreToolUse" && !id) return denyHook(hook, "工具事件缺少调用编号，不能跟踪内部路由。");
        const command = input.tool_input?.command;
        if (input.tool_name === "Bash" && this.matchesCommand(route, command)) {
          if (hook === "PreToolUse" && id && !route.controls.includes(id)) { route.controls.push(id); await save(file, route); }
          return {};
        }
        if (route.mode !== "continue") return denyHook(hook, "先按注入的路由说明判断本轮意图并调用内部 route 命令；当前尚未取得工具执行权。");
        return null;
      }
      if (id && route.controls.includes(id)) return {};
      if (route.mode !== "continue") {
        if (["Stop", "Interrupt", "SessionEnd"].includes(hook)) {
          route.ended = true;
          route.reply = String(input.last_assistant_message ?? input.lastAssistantMessage ?? "").slice(-4000);
          await save(file, route);
        }
        return {};
      }
      return null;
    });
    return decision ?? this.auto.handle(harness, input);
  }

  async decide({ cwd, harness, session, ticket, mode }) {
    if (!["side", "continue", "new"].includes(mode)) throw new Error("Unknown routing mode");
    const dir = await this.directory(cwd, harness, session), file = path.join(dir, "route.json");
    return transaction(dir, async () => {
      const route = await read(file);
      if (!route || route.ticket !== ticket || route.ended) throw new Error("意图票据已过期或轮次已结束");
      if (route.mode !== "undecided") {
        if (route.mode === mode && route.result) return route.result;
        throw new Error("本轮已完成路由，不允许切换或重复创建任务");
      }
      if (mode === "continue") {
        const current = await autoStatus(this.store.root, cwd);
        if (current?.taskId !== route.observedTask || (current?.owner?.key ?? null) !== route.observedOwner
          || (current?.owner?.turnId ?? null) !== route.observedTurn) throw new Error("任务已被另一轮推进；请结束本轮后重新判断，不能按旧快照抢占。");
        route.result = await this.auto.handle(harness, route.input, { expectedOwner: {
          taskId: route.observedTask, key: route.observedOwner, turnId: route.observedTurn } });
        if (route.result?.continue === false) return route.result;
      } else if (mode === "new") {
        const tasks = new WorktreeTasks({ store: this.store });
        // Persist provisioning before Git mutation. A failed/crashed creation
        // leaves inspectable state and never silently creates a duplicate.
        route.mode = "provisioning"; await save(file, route);
        const task = await tasks.create({ repo: cwd, goal: route.input.prompt, name: "task" });
        route.result = { taskId: task.id, cwd: task.cwd, branch: task.worktree.branch,
          baseCommit: task.worktree.baseCommit, command: (await tasks.launchPlan(task.id, harness)).command,
          message: "新任务已创建，源目录的未提交改动未复制。结束本轮以释放源目录；新会话必须从以上 worktree 开始。", launched: false };
        route.mode = mode; await save(file, route);
        try {
          const job = await this.startJob(task.id,harness,{model:route.input.model});
          route.result.launched = activeJob(job);
          route.result.job = {id:job.id,status:job.status,error:job.error??null};
          route.result.message = "独立任务已提交后台执行，原会话无需等待；执行成功后仍需检查测试和改动。";
        } catch (e) { route.result.launchError = e.message; }
      } else route.result = { mode: "side", message: "直接回答本次问题；原任务执行权及进展未改变。" };
      route.mode = mode;
      await save(file, route);
      return route.result;
    });
  }
}
