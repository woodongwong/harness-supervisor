import { autoStatus } from "./auto-handoff.mjs";
import fs from "node:fs/promises";
import { projectIdentity } from "./worktree-tasks.mjs";
import { taskIdentity, identityLine } from "./task-identity.mjs";
import { hasPendingWork } from "./task-progress.mjs";

async function projectTasks(store, project) {
  let entries;
  try { entries = await fs.readdir(store.tasksDir, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^task-[a-zA-Z0-9-]+$/.test(entry.name)) continue;
    const task = await store.get(entry.name);
    if (!task) continue;
    let identity = task.project;
    if (!identity) {
      try { identity = await projectIdentity(task.cwd); }
      catch { continue; } // Legacy records for removed/non-Git directories cannot be grouped.
    }
    if (identity.commonDir === project.commonDir) tasks.push(task);
  }
  return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function workspaceStatus(store, cwd, { repo } = {}) {
  const registration = await autoStatus(store.root, cwd);
  const task = registration?.taskId ? await store.require(registration.taskId) : null;
  let project = null;
  try { project = await projectIdentity(repo ?? cwd); }
  catch (error) { if (repo) throw error; }
  const tasks = project ? await projectTasks(store, project) : [];
  if (task && !tasks.some(t => t.id === task.id) && (!repo || task.project?.commonDir === project?.commonDir)) tasks.unshift(task);
  const rows = await Promise.all(tasks.map(async item => {
    const state = await autoStatus(store.root, item.cwd).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return { ...taskIdentity(item, state?.taskId === item.id ? state : null), hasPendingWork: hasPendingWork(item.progress) };
  }));
  return { cwd, current: task ? taskIdentity(task, registration) : null, project: project?.top ?? null, tasks: rows };
}

export function formatWorkspaceStatus(report) {
  const current = report.current;
  const lines = current ? [
    `当前目录关联任务：${identityLine(current)}`,
    `任务 ID：${current.taskId}\n目录：${current.cwd}\n登记分支：${current.branch ?? "未登记"}`,
    `执行会话：${current.owner ? `${current.owner.harness} / ${current.owner.sessionId}` : "尚未认领"}；在途工具：${current.runningTools}；等待交接：${current.pending ? "是" : "否"}`,
    "执行会话表示当前持有执行权的会话，不一定是发起本次查询的会话。",
  ] : ["当前目录未关联任务；不会自动选择其他 worktree 的任务。"];
  lines.push("", "同项目任务：");
  for (const task of report.tasks) lines.push(`${task.taskId === current?.taskId ? "*" : "-"} ${task.taskId} [${task.status}] ${identityLine(task)}${task.hasPendingWork ? " · 有待办" : ""}\n  登记分支：${task.branch ?? "未登记"}\n  ${task.cwd}`);
  if (!report.tasks.length) lines.push("暂无已登记任务。");
  return lines.join("\n");
}
