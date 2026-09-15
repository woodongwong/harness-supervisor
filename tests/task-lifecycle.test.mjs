import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { TaskStore } from "../src/store.mjs";
import { WorktreeTasks } from "../src/worktree-tasks.mjs";
import { TaskJobs, readJob, activeJob, jobLaunch } from "../src/task-jobs.mjs";
import { AutoHandoff, autoStatus, enableWorkspace } from "../src/auto-handoff.mjs";
import { integrateTask, planFinish } from "../src/task-integrate.mjs";

const git=(cwd,...args)=>execFileSync("git",["-C",cwd,...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"relay-lifecycle-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const repo=path.join(dir,"repo");await fs.mkdir(repo);git(repo,"init","-q","-b","main");
 git(repo,"config","user.name","Test");git(repo,"config","user.email","test@example.invalid");
 await fs.writeFile(path.join(repo,"file.txt"),"base\n");git(repo,"add","file.txt");git(repo,"commit","-qm","base");
 const store=new TaskStore(path.join(dir,"state")),tasks=new WorktreeTasks({store});
 const task=await tasks.create({repo,goal:"Create a result file and verify it"});
 return {dir,repo,store,tasks,task};
}
async function poll(store,id){for(let n=0;n<100;n++){const j=await readJob(store,id);if(j&&!activeJob(j))return j;await delay(30);}throw new Error("Worker did not exit");}

test("CodeBuddy background workers use a non-interactive permission mode",()=>{
 assert.deepEqual(jobLaunch("codebuddy").args,["-p","--output-format","json","--permission-mode","bypassPermissions"]);
});

test("detached worker receives task and cwd, exits durably and retries do not spawn twice",async t=>{
 const f=await fixture(t);const bin=path.join(f.dir,"fake-codex");
 await fs.writeFile(bin,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync('received.json',JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));console.log('done');`,{mode:0o700});
 const old=process.env.CODEX_BIN;process.env.CODEX_BIN=bin;t.after(()=>{if(old===undefined)delete process.env.CODEX_BIN;else process.env.CODEX_BIN=old;});
 const jobs=new TaskJobs({store:f.store});const a=await jobs.start(f.task.id,"codex"),b=await jobs.start(f.task.id,"codex");assert.equal(a.id,b.id);
 const done=await poll(f.store,f.task.id);assert.equal(done.status,"review_pending");assert.equal(done.exitCode,0);
 const receipt=JSON.parse(await fs.readFile(path.join(f.task.cwd,"received.json"),"utf8"));assert.equal(receipt.cwd,f.task.cwd);assert.match(receipt.args.at(-1),/Create a result file/);
 assert.equal(await fs.readFile(path.join(f.store.taskDir(f.task.id),"worker.stdout.log"),"utf8"),"done\n");
 assert.equal((await jobs.start(f.task.id,"codex")).id,a.id);
});

test("queued worker fences other native sessions and closing; missing binary leaves a failure record",async t=>{
 const f=await fixture(t);const old=process.env.CODEX_BIN;process.env.CODEX_BIN=path.join(f.dir,"missing");
 t.after(()=>{if(old===undefined)delete process.env.CODEX_BIN;else process.env.CODEX_BIN=old;});
 // Delay spawning to test the durable queued guard.
 const jobs=new TaskJobs({store:f.store,spawnImpl:()=>{throw new Error("launcher failed");}});
 const fail=await jobs.start(f.task.id,"codex");assert.equal(fail.status,"launch_failed");
 const next=await f.tasks.create({repo:f.repo,goal:"second"});
 await new TaskJobs({store:f.store}).start(next.id,"codex");
 const done=await poll(f.store,next.id);assert.equal(done.status,"failed");assert.match(done.error,/ENOENT/);
 const queued={...done,status:"queued"};await fs.writeFile(path.join(f.store.taskDir(next.id),"job.json"),JSON.stringify(queued));
 const response=await new AutoHandoff({root:f.store.root}).handle("codex",{cwd:next.cwd,session_id:"other",turn_id:"t",hook_event_name:"UserPromptSubmit",prompt:"take over"});
 assert.equal(response.continue,false);await assert.rejects(f.tasks.close(next.id),/后台任务/);
});

async function prepared(t){const f=await fixture(t);await fs.writeFile(path.join(f.task.cwd,"feature.txt"),"feature\n");git(f.task.cwd,"add","feature.txt");git(f.task.cwd,"commit","-qm","feature");return {...f,opts:{target:f.repo,branch:"main",sourceCommit:git(f.task.cwd,"rev-parse","HEAD"),targetCommit:git(f.repo,"rev-parse","HEAD"),verify:[process.execPath,"-e","require('node:assert').equal(require('node:fs').readFileSync('feature.txt','utf8'),'feature\\n')"]}};}
test("integration pins commits, verifies merged files and cleans only the requested worktree",async t=>{
 const f=await prepared(t);const other=await f.tasks.create({repo:f.repo,goal:"unrelated"});
 const result=await integrateTask(f.store,f.task.id,{...f.opts,cleanup:true});
 assert.equal(result.status,"verified");assert.equal(result.worktreeRemoved,true);assert.equal(result.branchRemoved,true);
 assert.equal(git(f.repo,"rev-parse","HEAD"),result.mergeCommit);
 await assert.rejects(fs.stat(f.task.cwd),{code:"ENOENT"});assert.ok(await fs.stat(other.cwd));
});
test("failed validation keeps source and integration evidence; no cleanup or push",async t=>{
 const f=await prepared(t);await assert.rejects(integrateTask(f.store,f.task.id,{...f.opts,cleanup:true,verify:[process.execPath,"-e","process.exit(2)"]}),/verifying/);
 assert.ok(await fs.stat(f.task.cwd));const r=JSON.parse(await fs.readFile(path.join(f.store.taskDir(f.task.id),"integration.json"),"utf8"));assert.equal(r.status,"verifying");assert.ok(r.error);
});
test("dirty target and stale commits are refused before source closure",async t=>{
 const f=await prepared(t);await fs.writeFile(path.join(f.repo,"unrelated.txt"),"keep");await assert.rejects(integrateTask(f.store,f.task.id,f.opts),/未提交/);
 assert.equal((await autoStatus(f.store.root,f.task.cwd)).closed,undefined);
 await fs.unlink(path.join(f.repo,"unrelated.txt"));await assert.rejects(integrateTask(f.store,f.task.id,{...f.opts,targetCommit:f.opts.sourceCommit}),/变化/);
});
test("a destination lease fences a stopped source session that omitted Stop",async t=>{
 const f=await prepared(t),auto=new AutoHandoff({root:f.store.root});
 await auto.handle("codex",{cwd:f.task.cwd,session_id:"source",turn_id:"source-turn",hook_event_name:"UserPromptSubmit",prompt:"prepare feature"});
 await enableWorkspace(f.store.root,f.repo);
 await auto.handle("codex",{cwd:f.repo,session_id:"target",turn_id:"target-turn",hook_event_name:"UserPromptSubmit",prompt:"merge feature"});
 const dest=await autoStatus(f.store.root,f.repo);
 const result=await integrateTask(f.store,f.task.id,{...f.opts,lease:dest.owner.lease});
 assert.equal(result.status,"verified");
 const source=await autoStatus(f.store.root,f.task.cwd);
 assert.equal(source.closed,true);assert.equal(source.owner.active,false);assert.ok(source.owner.fencedAt);
 const denied=await auto.handle("codex",{cwd:f.task.cwd,session_id:"source",turn_id:"source-turn",hook_event_name:"PreToolUse",tool_name:"Bash",tool_use_id:"late"});
 assert.equal(denied.hookSpecificOutput.permissionDecision,"deny");
});
test("an active source cannot be fenced without an active destination lease",async t=>{
 const f=await prepared(t),auto=new AutoHandoff({root:f.store.root});
 await auto.handle("codex",{cwd:f.task.cwd,session_id:"source",turn_id:"source-turn",hook_event_name:"UserPromptSubmit",prompt:"prepare feature"});
 await assert.rejects(integrateTask(f.store,f.task.id,f.opts),/目标目录当前轮次租约/);
 assert.equal((await autoStatus(f.store.root,f.task.cwd)).closed,undefined);
});
test("merge conflicts preserve both worktrees and unfinished merge",async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.task.cwd,"file.txt"),"source\n");git(f.task.cwd,"commit","-qam","source");await fs.writeFile(path.join(f.repo,"file.txt"),"target\n");git(f.repo,"commit","-qam","target");
 await assert.rejects(integrateTask(f.store,f.task.id,{target:f.repo,branch:"main",sourceCommit:git(f.task.cwd,"rev-parse","HEAD"),targetCommit:git(f.repo,"rev-parse","HEAD"),verify:[process.execPath,"-e",""],cleanup:true}),/merging/);
 assert.ok(await fs.stat(f.task.cwd));assert.match(git(f.repo,"status","--porcelain"),/UU/);
});

test("authorized finish plan is executed after the worker exits without a second user command",async t=>{
 const f=await fixture(t),bin=path.join(f.dir,"fake-worker"),cli=new URL("../src/cli.mjs",import.meta.url).pathname;
 const script=`#!/usr/bin/env node
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
fs.writeFileSync('feature.txt','ready');
execFileSync('git',['add','feature.txt']);execFileSync('git',['commit','-qm','feature']);
execFileSync(process.execPath,[${JSON.stringify(cli)},'task-plan-finish',process.env.HARNESS_RELAY_JOB_TASK,'--target',${JSON.stringify(f.repo)},'--branch','main','--verify-json',JSON.stringify([process.execPath,'-e',"require('node:assert').equal(require('node:fs').readFileSync('feature.txt','utf8'),'ready')"])]);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Prepared and tested'}}));
`;
 await fs.writeFile(bin,script,{mode:0o700});const old=process.env.CODEX_BIN;process.env.CODEX_BIN=bin;t.after(()=>{if(old===undefined)delete process.env.CODEX_BIN;else process.env.CODEX_BIN=old;});
 await assert.rejects(planFinish(f.store,f.task.id,{target:f.repo,branch:"main",verify:["true"]}),/活动 worker/);
 await new TaskJobs({store:f.store}).start(f.task.id,"codex");
 let job;for(let n=0;n<150;n++){job=await readJob(f.store,f.task.id);if(["integrated","integration_blocked","failed"].includes(job?.status))break;await delay(30);}
 assert.equal(job.status,"integrated",job.integrationError||job.error);
 assert.equal(job.integration.status,"verified");assert.equal(job.reply,"Prepared and tested");
 assert.equal(await fs.readFile(path.join(f.repo,"feature.txt"),"utf8"),"ready");
 assert.ok(await fs.stat(f.task.cwd));
});
