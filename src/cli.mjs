#!/usr/bin/env node
import process from "node:process";
import { HarnessSupervisor } from "./supervisor.mjs";
import { bindWorkspace, unbindWorkspace } from "../zcode-plugin/hooks/bindings.mjs";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
let supervisor;

function parse(argv) {
  const [command, ...rest] = argv;
  const values = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (!item.startsWith("--")) {
      values._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = rest[i + 1];
    values[key] = next && !next.startsWith("--") ? (i++, next) : true;
  }
  return { command, values };
}

function usage() {
  console.log(`harness-supervisor — Codex / ZCode 任务交接

  run --cwd <项目目录> --task <任务> [--primary codex|zcode] [--fallback codex|zcode|none]
  resume <task-id>
  takeover <task-id> --to codex|zcode [--feedback <说明>]
  bind-zcode <task-id>      绑定项目；随后在 ZCode 新建会话
  unbind-zcode <task-id>    停止 ZCode 后解除绑定
  status <task-id> [--json]
  capabilities
  unlock <task-id>          仅清理已退出 supervisor 的残留锁

run / resume / takeover 支持 --json 和 --timeout-seconds <秒>。
状态保存在 ~/.harness-supervisor；可用 HARNESS_SUPERVISOR_HOME 指定。
Codex 配置：CODEX_BIN、CODEX_SUPERVISOR_ARGS_JSON。
自定义 ZCode 启动器：ZCODE_BIN、ZCODE_SUPERVISOR_ARGS_JSON、ZCODE_SUPERVISOR_RESUME_ARGS_JSON。`);
}

const { command, values } = parse(process.argv.slice(2));
let timer;

function printResult(data) {
  if (values.json) return console.log(JSON.stringify(data, null, 2));
  const { task, result, events } = data;
  console.log(`任务：${task.id}\n状态：${task.status}\n执行器：${task.owner ?? task.primary}\n目录：${task.cwd}`);
  if (result?.output && task.status !== "awaiting_manual") console.log(`\n${result.output}`);
  if (task.error) console.error(`\n${task.error}`);
  if (events) console.log(`最近记录：${events.length} 条（--json 查看详情）`);
  if (task.status === "awaiting_manual") {
    console.log(`\n交接材料：${supervisor.store.contextPath(task.id)}\n下一步：node src/cli.mjs bind-zcode ${task.id}\n然后在 ZCode 打开该项目，新建会话并发送“继续交接任务”。需先启用 bridge 插件；未启用时手动提供交接材料。`);
  }
}


try {
  supervisor = new HarnessSupervisor({ signal: controller.signal });
  if (values["timeout-seconds"] !== undefined) {
    const seconds = Number(values["timeout-seconds"]);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("timeout-seconds must be positive");
    timer = setTimeout(() => controller.abort(), seconds * 1000);
    timer.unref();
  }
  if (command === "run") {
    if (typeof values.cwd !== "string" || typeof values.task !== "string" || !values.task.trim()) throw new Error("run requires --cwd and --task");
    const fallback = values.fallback === "none" ? null : (values.fallback ?? "zcode");
    const created = await supervisor.createTask({
      cwd: values.cwd,
      goal: values.task,
      primary: values.primary ?? "codex",
      fallback,
    });
    console.error(`任务已保存：${created.id}`);
    const { task, result } = await supervisor.run(created.id);
    printResult({ task, result });
    process.exitCode = task.status === "completed" ? 0 : task.status === "awaiting_manual" ? 2 : 1;
  } else if (command === "takeover") {
    const id = values._[0];
    if (!id || !values.to) throw new Error("takeover requires <task-id> --to <harness>");
    const { task, result } = await supervisor.takeover(id, values.to, values.feedback ?? "");
    printResult({ task, result });
    process.exitCode = task.status === "completed" ? 0 : task.status === "awaiting_manual" ? 2 : 1;
  } else if (command === "resume") {
    if (!values._[0]) throw new Error("resume requires <task-id>");
    const result = await supervisor.run(values._[0]);
    printResult(result);
    process.exitCode = result.task.status === "completed" ? 0 : result.task.status === "awaiting_manual" ? 2 : 1;
  } else if (command === "bind-zcode" || command === "unbind-zcode") {
    if (!values._[0]) throw new Error(`${command} requires <task-id>`);
    const task = await supervisor.store.require(values._[0]);
    const result = await supervisor.store.withTaskLock(task.id, async () => {
      if (command === "bind-zcode") {
        if (task.status !== "awaiting_manual") throw new Error("Prepare a ZCode takeover before binding");
        return bindWorkspace(supervisor.store.root, task, supervisor.store.taskDir(task.id));
      }
      return unbindWorkspace(supervisor.store.root, task);
    });
    console.log(command === "bind-zcode"
      ? `绑定已保存：${result}\n请在 ZCode 打开 ${task.cwd}，新建会话并发送“继续交接任务”。`
      : "已解除绑定，可以交回 Codex。");
  } else if (command === "unlock") {
    if (!values._[0]) throw new Error("unlock requires <task-id>");
    await supervisor.store.unlock(values._[0]);
    console.log("Stale supervisor lock removed. Confirm orphan workers are stopped before resuming.");
  } else if (command === "status") {
    const id = values._[0];
    if (!id) throw new Error("status requires <task-id>");
    const task = await supervisor.store.require(id);
    const events = await supervisor.store.readEvents(id, { limit: 20, includeExternal: true });
    printResult({ task, events });
  } else if (command === "capabilities") {
    console.log(JSON.stringify(supervisor.capabilities(), null, 2));
  } else {
    usage();
    if (command) process.exitCode = 2;
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
