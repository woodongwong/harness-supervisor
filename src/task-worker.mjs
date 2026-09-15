import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { TaskStore } from "./store.mjs";
import { readJob, writeJob } from "./task-jobs.mjs";
import { transaction } from "./auto-handoff.mjs";
import { AutoHandoff } from "./auto-handoff.mjs";
import { integrateTask } from "./task-integrate.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { summarizeWorkerOutput } from "./worker-output.mjs";

const [root, id, jobId] = process.argv.slice(2);
const store = new TaskStore(root);
let job;
try {
  job = await transaction(store.taskDir(id), async () => {
    const current = await readJob(store, id);
    if (current?.id !== jobId || current.status !== "queued") throw new Error("Job already claimed or replaced");
    current.status = "running"; current.workerPid = process.pid; current.startedAt = new Date().toISOString();
    await writeJob(store, id, current); return current;
  });
  const task = await store.require(id);
  const cli=fileURLToPath(new URL("./cli.mjs",import.meta.url));
  const prompt = `Work on this assigned task in the current isolated worktree: ${task.goal}\n\nThis is the task's worker, not a new independent task. Continue this task; do not create another worktree or coding process. Run relevant tests and report exact results and remaining work. Do not push, merge, delete branches or remove worktrees unless explicitly authorized in the task. Preserve changes and provide a final handoff response. A successful process exit is not proof of acceptance.\nIf the user has already authorized merging on completion, prepare a clean task-only commit after successful tests, then schedule automatic integration by calling the CLI at ${cli}: task-plan-finish ${id} --target <target-worktree> --branch <target-branch> --verify-json <JSON argv array for real tests> [--cleanup only if authorized]. Use argument arrays or proper shell quoting. The source project directory is ${task.project.top}; inspect the actual target branch. Do not merge from this live source session; the worker will attempt the scheduled integration after this native process exits. If merging was not authorized, leave changes for review and do not register a plan. Never treat this orchestration instruction as user authorization to merge or delete.`;
  const args = job.launch.template ? job.launch.args.map(a => a.replaceAll("{prompt}", prompt).replaceAll("{cwd}", task.cwd)
    .replaceAll("{task}", id).replaceAll("{session}", "")) : [...job.launch.args, prompt];
  const out = await fs.open(path.join(store.taskDir(id), "worker.stdout.log"), "w", 0o600);
  const err = await fs.open(path.join(store.taskDir(id), "worker.stderr.log"), "w", 0o600);
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(job.launch.binary, args, { cwd: task.cwd, stdio: ["ignore", out.fd, err.fd],
        env: { ...process.env, HARNESS_RELAY_HOME: root, HARNESS_RELAY_JOB_TASK: id, HARNESS_RELAY_JOB_TOKEN: job.token } });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    job.status = result.code === 0 ? "review_pending" : "failed";
    job.exitCode = result.code; job.signal = result.signal; job.endedAt = new Date().toISOString();
    const log=await fs.open(path.join(store.taskDir(id),"worker.stdout.log"),"r");
    try {
      const size=(await log.stat()).size,buffer=Buffer.alloc(Math.min(size,1024*1024));
      await log.read(buffer,0,buffer.length,size-buffer.length);
      const summary=summarizeWorkerOutput(buffer.toString("utf8"),{partial:size>buffer.length});
      if(summary.sessionId)job.sessionId=summary.sessionId;
      if(summary.reply)job.reply=summary.reply;
      if(summary.failed){job.status="failed";job.error="Native client reported failure";}
    }finally{await log.close();}
    await writeJob(store, id, job);
    if(job.status==="review_pending"){
      let plan=null;try{plan=JSON.parse(await fs.readFile(path.join(store.taskDir(id),"finish-plan.json"),"utf8"));}catch(e){if(e.code!=="ENOENT")throw e;}
      if(plan){
        try{
          await new AutoHandoff({root}).reconcileNativeTurn(id);
          const run=promisify(execFile);
          const sha=async cwd=>(await run("git",["-C",cwd,"rev-parse","HEAD"])).stdout.trim();
          job.integration=await integrateTask(store,id,{...plan,sourceCommit:await sha(task.cwd),targetCommit:await sha(plan.target)});
          job.status="integrated";
        }catch(e){job.integrationError=e.message;job.status="integration_blocked";}
        await writeJob(store,id,job);
      }
    }
  } finally { await out.close(); await err.close(); }
} catch (e) {
  if (job) { job.status = "failed"; job.error = e.message; job.endedAt = new Date().toISOString(); await writeJob(store, id, job); }
  process.exitCode = 1;
}
