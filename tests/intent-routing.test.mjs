import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { IntentRouting } from "../src/intent-routing.mjs";
import { autoStatus, enableWorkspace } from "../src/auto-handoff.mjs";
import { WorktreeTasks } from "../src/worktree-tasks.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-intent-"));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const cwd=path.join(dir,"repo"),root=path.join(dir,"state");await fs.mkdir(cwd);
  execFileSync("git",["init","-q",cwd]);
  await fs.writeFile(path.join(cwd,"file.txt"),"base\n");
  execFileSync("git",["-C",cwd,"add","file.txt"]);
  execFileSync("git",["-C",cwd,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","base"]);
  await enableWorkspace(root,cwd);
  const router=new IntentRouting({root,waitMs:5,startJob:async()=>({id:"test-job",status:"queued"})});
  const send=(session,hook,extra={})=>router.handle("codex",{cwd,session_id:session,turn_id:session+"-turn",hook_event_name:hook,...extra});
  const route=async(session)=>JSON.parse(await fs.readFile(path.join(await router.directory(cwd,"codex",session),"route.json"),"utf8"));
  const decide=async(session,mode)=>router.decide({cwd,harness:"codex",session,ticket:(await route(session)).ticket,mode});
  return {cwd,root,router,send,route,decide};
}

test("another window can ask and answer without interrupting active work or altering its checkpoint",async t=>{
  const f=await fixture(t);
  await f.send("a","UserPromptSubmit",{prompt:"Implement login"});await f.decide("a","continue");
  await f.send("a","PreToolUse",{tool_name:"Bash",tool_use_id:"running"});
  const before=await autoStatus(f.root,f.cwd);
  await f.send("b","UserPromptSubmit",{prompt:"Is that Beijing time?"});
  await f.send("b","Stop",{last_assistant_message:"Yes."});
  assert.deepEqual(await autoStatus(f.root,f.cwd),before);
  assert.equal((await f.route("b")).reply,"Yes.");
  const next=await f.send("a","PreToolUse",{tool_name:"Bash",tool_use_id:"next"});
  assert.deepEqual(next,{});
});

test("undecided and side turns allow equivalent static route argv but reject shell features",async t=>{
  const f=await fixture(t);await f.send("b","UserPromptSubmit",{prompt:"Explain this"});
  const command=f.router.commands(await f.route("b")).side;
  assert.deepEqual(await f.send("b","PreToolUse",{tool_name:"Bash",tool_use_id:"control",tool_input:{command}}),{});
  const modelNormalized=command.replace(/^'([^']+)'/,"$1");
  assert.deepEqual(await f.send("b","PreToolUse",{tool_name:"Bash",tool_use_id:"normalized",tool_input:{command:modelNormalized}}),{});
  const bad=await f.send("b","PreToolUse",{tool_name:"Bash",tool_use_id:"bad",tool_input:{command:command+"; echo bypass"}});
  assert.equal(bad.hookSpecificOutput.permissionDecision,"deny");
  for(const suffix of [" | cat"," > /tmp/out"," $(echo bypass)"," `echo bypass`"," && true"]) {
    const denied=await f.send("b","PreToolUse",{tool_name:"Bash",tool_use_id:`bad-${suffix}`,tool_input:{command:command+suffix}});
    assert.equal(denied.hookSpecificOutput.permissionDecision,"deny");
  }
  assert.equal((await f.send("b","PreToolUse",{turn_id:undefined,tool_name:"Bash",tool_use_id:"no-turn",tool_input:{command}})).hookSpecificOutput.permissionDecision,"deny");
  assert.equal((await f.send("b","PreToolUse",{tool_name:"Bash",tool_input:{command}})).hookSpecificOutput.permissionDecision,"deny");
  await f.decide("b","side");
  assert.equal((await f.send("b","PreToolUse",{tool_name:"Read",tool_use_id:"read"})).hookSpecificOutput.permissionDecision,"deny");
  assert.equal((await autoStatus(f.root,f.cwd)).owner,null);
});

test("model can continue an idle task and gets its handoff context without user routing syntax",async t=>{
  const f=await fixture(t);await f.send("a","UserPromptSubmit",{prompt:"Fix login"});await f.decide("a","continue");
  await f.send("a","Stop",{last_assistant_message:"Implementation ready; tests pending."});
  await f.send("b","UserPromptSubmit",{prompt:"Run those tests"});
  assert.equal((await autoStatus(f.root,f.cwd)).owner.sessionId,"a");
  const result=await f.decide("b","continue");
  assert.match(result.hookSpecificOutput.additionalContext,/tests pending/);
  assert.equal((await autoStatus(f.root,f.cwd)).owner.sessionId,"b");
});

test("independent intent creates one worktree without touching the busy source or duplicating on retry",async t=>{
  const f=await fixture(t);await f.send("a","UserPromptSubmit",{prompt:"Fix login"});await f.decide("a","continue");
  const before=await autoStatus(f.root,f.cwd);
  await f.send("b","UserPromptSubmit",{prompt:"Build a separate report"});
  const old=process.env.HARNESS_RELAY_TERMINAL_JSON;delete process.env.HARNESS_RELAY_TERMINAL_JSON;
  t.after(()=>{if(old===undefined)delete process.env.HARNESS_RELAY_TERMINAL_JSON;else process.env.HARNESS_RELAY_TERMINAL_JSON=old;});
  const result=await f.decide("b","new");
  assert.notEqual(result.cwd,f.cwd);assert.equal(result.launched,true);
  assert.equal(await fs.readFile(path.join(result.cwd,"file.txt"),"utf8"),"base\n");
  assert.deepEqual(await autoStatus(f.root,f.cwd),before);
  assert.deepEqual(await f.decide("b","new"),result);
  assert.equal((await new WorktreeTasks({store:f.router.store}).list(f.cwd)).length,1);
  assert.equal((await f.send("b","PreToolUse",{tool_name:"Bash",tool_use_id:"oops"})).hookSpecificOutput.permissionDecision,"deny");
});

test("stale tickets, ended turns and changed ownership cannot authorize a takeover",async t=>{
  const f=await fixture(t);await f.send("a","UserPromptSubmit",{prompt:"Work"});await f.decide("a","continue");
  await f.send("b","UserPromptSubmit",{prompt:"Continue"});
  await f.send("a","Stop");
  await f.send("a","UserPromptSubmit",{turn_id:"new-turn",prompt:"Another step"});await f.decide("a","continue");
  await assert.rejects(f.decide("b","continue"),/另一轮/);
  const previous=await f.route("b");
  await f.send("b","UserPromptSubmit",{turn_id:"new-b",prompt:"Question"});
  await assert.rejects(f.router.decide({cwd:f.cwd,harness:"codex",session:"b",ticket:previous.ticket,mode:"side"}),/过期/);
  await f.send("b","Stop",{turn_id:"new-b"});await assert.rejects(f.decide("b","side"),/结束/);
});

test("native hook and internal CLI perform the model-selected routing across separate processes",async t=>{
  const f=await fixture(t),cli=new URL("../src/cli.mjs",import.meta.url).pathname;
  const hook=new URL("../src/auto-hook.mjs",import.meta.url).pathname;
  const p=spawnSync(process.execPath,[hook,"codex",f.root],{encoding:"utf8",input:JSON.stringify({cwd:f.cwd,session_id:"c",turn_id:"t",hook_event_name:"UserPromptSubmit",prompt:"Work"})});
  assert.equal(p.status,0,p.stderr);assert.match(JSON.parse(p.stdout).hookSpecificOutput.additionalContext,/infer/);
  const route=await f.route("c");
  const r=spawnSync(process.execPath,[cli,"route","--root",f.root,"--cwd",f.cwd,"--harness","codex","--session","c","--ticket",route.ticket,"--mode","continue"],{encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext);
  assert.equal((await autoStatus(f.root,f.cwd)).owner.sessionId,"c");
});

test("ZCode camelCase hooks preserve route identity and tool completion",async t=>{
  const f=await fixture(t);
  const input={cwd:f.cwd,sessionId:"z",turnId:"z-turn"};
  const prompt=await f.router.handle("zcode",{...input,hookEventName:"UserPromptSubmit",prompt:"Work"});
  assert.ok(prompt.hookSpecificOutput.additionalContext);
  const route=JSON.parse(await fs.readFile(path.join(await f.router.directory(f.cwd,"zcode","z"),"route.json"),"utf8"));
  await f.router.decide({cwd:f.cwd,harness:"zcode",session:"z",ticket:route.ticket,mode:"continue"});
  await f.router.handle("zcode",{...input,hookEventName:"PreToolUse",toolCallId:"x",toolName:"Bash",toolInput:{command:"echo ok"}});
  assert.equal(Object.keys((await autoStatus(f.root,f.cwd)).tools).length,1);
  await f.router.handle("zcode",{...input,hookEventName:"PostToolUse",toolCallId:"x",toolName:"Bash"});
  await f.router.handle("zcode",{...input,hookEventName:"Stop",responseText:"Ready"});
  const state=await autoStatus(f.root,f.cwd);
  assert.equal(state.owner.active,false);assert.deepEqual(state.tools,{});
  assert.equal(state.checkpoints.zcode.reply,"Ready");
});
