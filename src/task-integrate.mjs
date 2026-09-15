import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeTasks, projectIdentity } from "./worktree-tasks.mjs";
import { autoStatus, autoDirectory, enableWorkspace, transaction } from "./auto-handoff.mjs";
import { readJob, activeJob } from "./task-jobs.mjs";

const exec = promisify(execFile);
async function git(cwd,...args) { return (await exec("git",["-C",cwd,...args],{maxBuffer:1024*1024})).stdout.trim(); }
async function clean(cwd) {
  if (await git(cwd,"status","--porcelain")) throw new Error("工作目录存在未提交或未跟踪改动，请先处理本任务提交，保留无关文件");
  for (const name of ["MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD","rebase-merge","rebase-apply"]) {
    const file=await git(cwd,"rev-parse","--git-path",name);
    try { await fs.lstat(path.resolve(cwd,file)); } catch(e) { if(e.code==="ENOENT")continue;throw e; }
    throw new Error("存在未完成的 Git 操作");
  }
}

// Commits are prepared by the native model; integration consumes pinned commits
// and a real validation argv. It never invents acceptance from a Stop event.
export async function integrateTask(store,id,{target,branch,sourceCommit,targetCommit,verify,cleanup=false,lease}) {
  if (![sourceCommit,targetCommit].every(s=>typeof s==="string"&&/^[a-f0-9]{40,64}$/.test(s))) throw new Error("需要完整 source/target 提交编号");
  if(typeof branch!=="string"||!branch||!Array.isArray(verify)||!verify.length||verify.some(a=>typeof a!=="string")||!verify[0]) throw new Error("需要目标分支及验证命令 JSON 参数数组");
  const tasks=new WorktreeTasks({store}),task=await tasks.require(id);
  target=await fs.realpath(target);
  const project=await projectIdentity(target);
  if(project.commonDir!==task.project.commonDir||target===task.cwd||project.top!==target)throw new Error("目标必须是同仓库的另一个 worktree 根目录");
  if(await git(task.cwd,"branch","--show-current")!==task.worktree.branch||await git(target,"branch","--show-current")!==branch)throw new Error("源或目标分支与登记不符");
  if(await git(task.cwd,"rev-parse","HEAD")!==sourceCommit||await git(target,"rev-parse","HEAD")!==targetCommit)throw new Error("提交已变化，请重新检查");
  await clean(task.cwd);await clean(target);
  if(activeJob(await readJob(store,id)))throw new Error("后台任务尚未结束");
  await enableWorkspace(store.root,target);
  return transaction(await autoDirectory(store.root,target),async()=>{
    const dest=await autoStatus(store.root,target);
    if(dest.closed||dest.pending||(dest.owner?.active&&dest.owner.lease!==lease)
      ||(!dest.owner?.active&&Object.keys(dest.tools).length))throw new Error("目标目录仍被其他会话或工具占用");
    if(dest.taskId&&activeJob(await readJob(store,dest.taskId)))throw new Error("目标后台任务尚未结束");
    const source=await autoStatus(store.root,task.cwd);
    if(source?.owner?.active&&!dest.owner?.active)throw new Error("源会话尚未停止；仅持有目标目录当前轮次租约的会话可以封存它");
    // A valid destination lease represents the active integration turn. If the
    // source client omitted Stop but has no tools or pending handoff, close its
    // gate while both directories are locked. Any later source tool is denied.
    await tasks.close(id,{fenceActive:!!source?.owner?.active&&dest.owner?.active&&dest.owner.lease===lease});
    // Check again after fencing the source and acquiring the destination gate.
    await clean(task.cwd);await clean(target);
    if(await git(task.cwd,"branch","--show-current")!==task.worktree.branch||await git(target,"branch","--show-current")!==branch)throw new Error("准备期间分支发生变化");
    if(await git(task.cwd,"rev-parse","HEAD")!==sourceCommit||await git(target,"rev-parse","HEAD")!==targetCommit)throw new Error("提交在准备期间发生变化");
    const record={sourceCommit,targetCommit,target,branch,verify,startedAt:new Date().toISOString(),status:"merging"};
    const file=path.join(store.taskDir(id),"integration.json");
    const save=()=>fs.writeFile(file,JSON.stringify(record,null,2)+"\n",{mode:0o600});
    await save();
    try {
      await git(target,"merge","--no-ff","--no-edit",sourceCommit);
      record.mergeCommit=await git(target,"rev-parse","HEAD");record.status="verifying";await save();
      const check=await exec(verify[0],verify.slice(1),{cwd:target,timeout:300000,maxBuffer:1024*1024});
      await fs.writeFile(path.join(store.taskDir(id),"integration-verification.log"),check.stdout+check.stderr,{mode:0o600});
      await clean(target);
      if(await git(target,"rev-parse","HEAD")!==record.mergeCommit)throw new Error("验证期间目标提交变化");
      if(await git(target,"branch","--show-current")!==branch)throw new Error("验证期间目标分支变化");
      record.status="verified";await save();
      if(cleanup){
        await clean(task.cwd);
        if(await git(task.cwd,"status","--porcelain","--ignored"))throw new Error("源 worktree 存在忽略文件，保留目录以免丢失本地数据");
        if(await git(task.cwd,"rev-parse","HEAD")!==sourceCommit||await git(target,"rev-parse",task.worktree.branch)!==sourceCommit)throw new Error("源分支发生变化，不清理");
        await git(target,"merge-base","--is-ancestor",sourceCommit,record.mergeCommit);
        await git(target,"worktree","remove",task.cwd);
        record.worktreeRemoved=true;await save();
        await git(target,"branch","-d",task.worktree.branch);record.branchRemoved=true;
      }
      record.endedAt=new Date().toISOString();await save();return record;
    }catch(e){record.error=String(e.stderr||e.message).slice(-2000);record.failedAt=new Date().toISOString();
      if(e.stdout||e.stderr)await fs.writeFile(path.join(store.taskDir(id),"integration-error.log"),String(e.stdout??"")+String(e.stderr??""),{mode:0o600});
      await save();throw new Error(`合并收尾未完成（${record.status}），保留现场：${record.error}`);}
  });
}

export async function planFinish(store,id,{target,branch,verify,cleanup=false}) {
  const job=await readJob(store,id);
  if(!activeJob(job)||process.env.HARNESS_RELAY_JOB_TASK!==id||process.env.HARNESS_RELAY_JOB_TOKEN!==job.token)throw new Error("仅该任务的活动 worker 可登记自动收尾计划");
  if(typeof branch!=="string"||!branch||!Array.isArray(verify)||!verify.length||verify.some(a=>typeof a!=="string")||!verify[0])throw new Error("需要目标分支和验证参数数组");
  const task=await new WorktreeTasks({store}).require(id),project=await projectIdentity(target);
  if(project.commonDir!==task.project.commonDir||project.top===task.cwd)throw new Error("收尾目标必须是同仓库的另一目录");
  const plan={target:project.top,branch,verify,cleanup,createdAt:new Date().toISOString()};
  await fs.writeFile(path.join(store.taskDir(id),"finish-plan.json"),JSON.stringify(plan)+"\n",{mode:0o600});
  return plan;
}
