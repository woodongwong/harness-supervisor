import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { TaskStore } from "./store.mjs";
import { newTaskId } from "./util.mjs";
import { enableWorkspace, autoStatus, closeWorkspaceTask } from "./auto-handoff.mjs";

const exec = promisify(execFile);
async function git(cwd, args) {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], { timeout: 30000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Git 操作失败：${String(error.stderr || error.message).trim().slice(0, 1000)}`);
  }
}

export async function projectIdentity(repo) {
  const cwd = await fs.realpath(repo);
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const commonDir = await fs.realpath(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return { top, commonDir, key: crypto.createHash("sha256").update(commonDir).digest("hex").slice(0, 16) };
}

export class WorktreeTasks {
  constructor({ store = new TaskStore() } = {}) { this.store = store; }

  async create({ repo, goal, name = "task", base = "HEAD" }) {
    if (typeof goal !== "string" || !goal.trim()) throw new Error("任务描述不能为空");
    if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name)) throw new Error("name 需为 1–48 位字母、数字、下划线或连字符");
    if (typeof base !== "string" || !base.trim()) throw new Error("base 不能为空");
    const project = await projectIdentity(repo);
    const baseCommit = await git(project.top, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
    const id = newTaskId();
    const cwd = path.join(this.store.root, "worktrees", project.key, `${name}-${id}`);
    const branch = `harness/${id}`;
    const task = await this.store.create({ id, cwd, goal, primary: "codex", fallback: null });
    task.project = project;
    task.name = name;
    task.worktree = { branch, base, baseCommit, managed: true };
    task.status = "provisioning";
    await this.store.save(task);
    try {
      await fs.mkdir(path.dirname(cwd), { recursive: true });
      // Resolve the base before creating the branch. No force flags, no copy of
      // the user's dirty index, and no shell interpretation of names/paths.
      await git(project.top, ["worktree", "add", "-b", branch, "--", cwd, baseCommit]);
      task.status = "ready";
      await this.store.save(task);
      await enableWorkspace(this.store.root, cwd, { taskId: id, scope: "worktree" });
      return task;
    } catch (error) {
      task.status = "setup_failed";
      task.error = error.message;
      await this.store.save(task);
      throw new Error(`${error.message}\n任务 ${id} 的记录和可能已创建的 worktree 已保留：${cwd}`);
    }
  }

  async list(repo) {
    const project = repo ? await projectIdentity(repo) : null;
    await this.store.initialize();
    const tasks = [];
    for (const entry of await fs.readdir(this.store.tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^task-[a-zA-Z0-9-]+$/.test(entry.name)) continue;
      const task = await this.store.get(entry.name);
      if (!task?.worktree || (project && task.project?.commonDir !== project.commonDir)) continue;
      tasks.push(task);
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async require(id) {
    const task = await this.store.require(id);
    if (!task.worktree?.managed) throw new Error("此任务不是受管理的 worktree 任务");
    const project = await projectIdentity(task.cwd);
    if (project.commonDir !== task.project.commonDir || await fs.realpath(project.top) !== await fs.realpath(task.cwd)) throw new Error("worktree 已被移动或替换，请检查任务记录");
    return task;
  }

  async close(id) {
    return closeWorkspaceTask(this.store, await this.require(id));
  }

  async location(id) {
    const task = await this.require(id);
    const state = await autoStatus(this.store.root, task.cwd);
    if (!state || state.taskId !== id) throw new Error("worktree 尚未正确接入自动交接");
    if (state.closed) throw new Error("任务已关闭；代码和分支仍保留，可手动查看");
    return task;
  }

  async open(id, harness, { spawnImpl = spawn } = {}) {
    const task = await this.location(id);
    if (!["codex", "zcode"].includes(harness)) throw new Error("--in 只支持 codex 或 zcode");
    const binary = harness === "codex" ? (process.env.CODEX_BIN || "codex")
      : (process.env.ZCODE_DESKTOP_BIN || (process.platform === "linux" ? "/opt/ZCode/zcode" : "zcode"));
    const args = harness === "codex" ? ["-C", task.cwd] : [task.cwd];
    return new Promise((resolve, reject) => {
      const child = spawnImpl(binary, args, { cwd: task.cwd, stdio: "inherit", env: process.env });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ task, code: code ?? 1, signal }));
    });
  }
}
