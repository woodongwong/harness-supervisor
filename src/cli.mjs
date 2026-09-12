#!/usr/bin/env node
import process from "node:process";
import fs from "node:fs/promises";
import { HarnessRelay } from "./supervisor.mjs";
import { bindWorkspace, unbindWorkspace } from "../zcode-plugin/hooks/bindings.mjs";
import { installAuto } from "./auto-install.mjs";
import { autoStatus, AutoHandoff } from "./auto-handoff.mjs";
import { WorktreeTasks } from "./worktree-tasks.mjs";
import { workspaceStatus, formatWorkspaceStatus } from "./task-status.mjs";

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
  console.log(`harness-relay — 多 harness 任务交接（已接入 Codex / ZCode）

  run --cwd <项目目录> --task <任务> [--primary codex|zcode] [--fallback codex|zcode|none]
  setup-auto --cwd <项目目录>  一次性接入 Codex / ZCode 的自动交接
  auto-status --cwd <项目目录> 查看当前会话、交接等待与工具状态
  task-new --repo <仓库> --task <目标> [--name <短名>] [--base <提交或分支>]
  task-list [--repo <仓库>] [--json]
  task-open <task-id> [--in codex|zcode]  打开原生客户端；省略 --in 时显示目录
  task-close <task-id>     关闭空闲任务，保留 worktree、分支和记录
  resume <task-id>
  takeover <task-id> --to codex|zcode [--feedback <说明>]
  bind-zcode <task-id>      绑定项目；随后在 ZCode 新建会话
  unbind-zcode <task-id>    停止 ZCode 后解除绑定
  status <task-id> [--json]
  status [--cwd <当前目录>] [--repo <仓库>] [--json]  当前身份及同项目任务
  task-state --cwd <目录>   读取跨轮次任务状态（JSON）
  task-state --cwd <目录> --update <JSON文件> --lease <本轮租约> --revision <版本>
  capabilities
  unlock <task-id>          仅清理已退出 supervisor 的残留锁

run / resume / takeover 支持 --json 和 --timeout-seconds <秒>。
新安装状态保存在 ~/.harness-relay；已有旧数据目录会继续使用。可用 HARNESS_RELAY_HOME 指定。
Codex 配置：CODEX_BIN、CODEX_RELAY_ARGS_JSON。
自定义 ZCode 启动器：ZCODE_BIN、ZCODE_RELAY_ARGS_JSON、ZCODE_RELAY_RESUME_ARGS_JSON。`);
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
  supervisor = new HarnessRelay({ signal: controller.signal });
  if (values["timeout-seconds"] !== undefined) {
    const seconds = Number(values["timeout-seconds"]);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("timeout-seconds must be positive");
    timer = setTimeout(() => controller.abort(), seconds * 1000);
    timer.unref();
  }
  const worktrees = new WorktreeTasks({ store: supervisor.store });
  if (command === "task-new") {
    if (typeof values.repo !== "string" || typeof values.task !== "string") throw new Error("task-new requires --repo and --task");
    const task = await worktrees.create({ repo: values.repo, goal: values.task, name: values.name ?? "task", base: values.base ?? "HEAD" });
    if (values.json) console.log(JSON.stringify(task, null, 2));
    else console.log(`任务：${task.id}\n目标：${task.goal}\nworktree：${task.cwd}\n分支：${task.worktree.branch}\n基点：${task.worktree.baseCommit}\n\n在 Codex / ZCode 打开此 worktree 即可关联本任务。工作树来自已提交内容，不包含原目录未提交的改动。`);
  } else if (command === "task-list") {
    const tasks = await worktrees.list(values.repo);
    if (values.json) console.log(JSON.stringify(tasks, null, 2));
    else console.log(tasks.map(task => `${task.id} [${task.status}] ${task.goal}\n  ${task.cwd}`).join("\n") || "暂无 worktree 任务。");
  } else if (command === "task-open") {
    if (!values._[0]) throw new Error("task-open requires <task-id>");
    if (values.in) {
      const result = await worktrees.open(values._[0], values.in);
      process.exitCode = result.code;
    } else {
      const task = await worktrees.location(values._[0]);
      console.log(values.json ? JSON.stringify(task, null, 2) : task.cwd);
    }
  } else if (command === "task-close") {
    if (!values._[0]) throw new Error("task-close requires <task-id>");
    const task = await worktrees.close(values._[0]);
    console.log(`任务已关闭：${task.id}\nworktree 和分支已保留：${task.cwd}\n${task.worktree.branch}\n可审查、测试后自行合并；此操作未合并或删除代码。`);
  } else if (command === "setup-auto") {
    if (typeof values.cwd !== "string") throw new Error("setup-auto requires --cwd");
    const result = await installAuto({ root: supervisor.store.root, cwd: values.cwd });
    console.log(JSON.stringify(result, null, 2));
    console.log("配置已保存。Codex 需在 /hooks 中一次性审阅并信任新 Hook；两端新建会话后，在该项目正常发送消息即可自动交接。");
  } else if (command === "auto-status") {
    if (typeof values.cwd !== "string") throw new Error("auto-status requires --cwd");
    console.log(JSON.stringify(await autoStatus(supervisor.store.root, values.cwd), null, 2));
  } else if (command === "task-state") {
    if (typeof values.cwd !== "string") throw new Error("task-state requires --cwd");
    const auto = new AutoHandoff({ root: supervisor.store.root });
    if (values.update !== undefined) {
      if (typeof values.update !== "string" || typeof values.lease !== "string" || typeof values.revision !== "string" || !/^\d+$/.test(values.revision)) throw new Error("Update requires --update <JSON-file> --lease <lease> --revision <integer>");
      const info = await fs.stat(values.update);
      if (info.size > 256 * 1024) throw new Error("Progress patch exceeds 256 KiB");
      const patch = JSON.parse(await fs.readFile(values.update, "utf8"));
      console.log(JSON.stringify(await auto.updateProgress({ cwd: values.cwd, lease: values.lease, revision: Number(values.revision), patch }), null, 2));
    } else console.log(JSON.stringify(await auto.taskState(values.cwd), null, 2));
  } else if (command === "run") {
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
    if (id) {
      const task = await supervisor.store.require(id);
      const events = await supervisor.store.readEvents(id, { limit: 20, includeExternal: true });
      printResult({ task, events });
    } else {
      const report = await workspaceStatus(supervisor.store, values.cwd ?? process.cwd(), { repo: values.repo });
      console.log(values.json ? JSON.stringify(report, null, 2) : formatWorkspaceStatus(report));
    }
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
