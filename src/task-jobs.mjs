import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskStore } from "./store.mjs";
import { WorktreeTasks } from "./worktree-tasks.mjs";
import { autoStatus, autoDirectory, transaction } from "./auto-handoff.mjs";

export const activeJob = job => ["queued", "running"].includes(job?.status);
export async function readJob(store, id) {
  try { return JSON.parse(await fs.readFile(path.join(store.taskDir(id), "job.json"), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
export async function writeJob(store, id, job) {
  const file = path.join(store.taskDir(id), "job.json"), tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(job) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
}
export function jobLaunch(harness) {
  if (harness === "codex") return { binary: process.env.CODEX_BIN || "codex", args: ["exec", "--json"] };
  if (harness === "codebuddy") return {
    binary: process.env.CODEBUDDY_BIN || "codebuddy",
    // Background workers have no terminal in which CodeBuddy can ask for
    // permission.  The user already authorized this isolated task when it was
    // queued, so give the worker the non-interactive permission mode explicitly.
    args: ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions"],
  };
  if (harness === "zcode" && process.env.ZCODE_RELAY_ARGS_JSON) {
    const args = JSON.parse(process.env.ZCODE_RELAY_ARGS_JSON);
    if (Array.isArray(args) && args.length && args.every(a => typeof a === "string") && args.some(a => a.includes("{prompt}"))) {
      return { binary: process.env.ZCODE_BIN || "zcode", args, template: true };
    }
  }
  throw new Error("该 harness 尚无可用的非交互任务入口；保留 worktree，不切换模型或账户。");
}

export class TaskJobs {
  constructor({ store = new TaskStore(), spawnImpl = spawn } = {}) { this.store = store; this.spawnImpl = spawnImpl; }
  async start(id, harness, { model } = {}) {
    const tasks = new WorktreeTasks({ store: this.store });
    const task = await tasks.location(id);
    const launch = jobLaunch(harness);
    if(typeof model==="string"&&model&&["codex","codebuddy"].includes(harness))launch.args.push("--model",model);
    return transaction(await autoDirectory(this.store.root, task.cwd), () => transaction(this.store.taskDir(id), async () => {
      const existing = await readJob(this.store, id);
      if (existing) return existing; // Retries never spawn a duplicate or rerun mutations.
      const state = await autoStatus(this.store.root, task.cwd);
      if (state?.owner?.active || state?.pending || Object.keys(state?.tools ?? {}).length) throw new Error("任务仍被会话占用，不能启动后台执行");
      const job = { version: 1, id: crypto.randomUUID(), taskId: id, harness, launch,
        token: crypto.randomUUID(), status: "queued", queuedAt: new Date().toISOString(), cwd: task.cwd };
      await writeJob(this.store, id, job);
      const worker = fileURLToPath(new URL("./task-worker.mjs", import.meta.url));
      try {
        await new Promise((resolve, reject) => {
          const child = this.spawnImpl(process.execPath, [worker, this.store.root, id, job.id], {
            cwd: this.store.taskDir(id), stdio: "ignore", detached: true, env: process.env,
          });
          child.once("error", reject);
          child.once("spawn", () => { child.unref(); resolve(); });
        });
      } catch (e) { job.status = "launch_failed"; job.error = e.message; await writeJob(this.store, id, job); }
      return job;
    }));
  }
}
