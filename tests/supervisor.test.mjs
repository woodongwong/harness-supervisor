import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { TaskStore } from "../src/store.mjs";

class FakeAdapter {
  constructor(name, results) {
    this.name = name;
    this.results = [...results];
    this.prompts = [];
  }

  capabilities() {
    return { harness: this.name, headless: true, resumeSession: this.name === "codex" };
  }

  async run({ prompt, onEvent }) {
    this.prompts.push(prompt);
    await onEvent({
      type: "worker.native",
      harness: this.name,
      payload: this.name === "codex"
        ? { type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 1 } }
        : { type: "stdout", text: "continuing" },
    });
    return this.results.shift();
  }
}

test("quota failure hands the same task to the other native harness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hs-store-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hs-repo-"));
  const codex = new FakeAdapter("codex", [
    { exitCode: 1, signal: null, sessionId: "c1", output: "", stderr: "usage limit", reason: "quota" },
  ]);
  const zcode = new FakeAdapter("zcode", [
    { exitCode: 0, signal: null, sessionId: "z1", output: "done", stderr: "", reason: null },
  ]);
  const supervisor = new HarnessSupervisor({
    store: new TaskStore(root),
    adapters: { codex, zcode },
  });

  const { task } = await supervisor.runNew({ cwd, goal: "fix auth", primary: "codex", fallback: "zcode" });
  assert.equal(task.status, "completed");
  assert.equal(task.sessions.codex, "c1");
  assert.equal(task.sessions.zcode, "z1");
  assert.equal(task.attempts.length, 2);
  assert.match(zcode.prompts[0], /taking over an existing coding task/i);
  assert.match(zcode.prompts[0], /usage limit|quota/i);

  const events = await supervisor.store.readEvents(task.id, { limit: 100 });
  assert.ok(events.some((event) => event.type === "worker.failover" && event.from === "codex" && event.to === "zcode"));
});

test("unconfigured ZCode becomes a manual handoff, retaining Codex failure", async () => {
  const { ZCodeAdapter } = await import("../src/adapters/zcode.mjs");
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"hs-manual-"));
  const codex=new FakeAdapter("codex",[{exitCode:1,sessionId:"quota-thread",stderr:"usage limit",reason:"quota"}]);
  const zcode=new ZCodeAdapter({argsTemplate:[],spawnImpl:()=>{throw new Error("must not spawn");}});
  const supervisor=new HarnessSupervisor({store:new TaskStore(root),adapters:{codex,zcode}});
  const {task,result}=await supervisor.runNew({cwd:root,goal:"finish project",primary:"codex",fallback:"zcode"});
  assert.equal(task.status,"awaiting_manual");assert.equal(task.sessions.codex,"quota-thread");
  assert.equal(task.attempts.length,1);assert.equal(zcode.capabilities().headless,false);
  assert.match(await fs.readFile(result.contextPath,"utf8"),/finish project/);
  await assert.rejects(supervisor.run(task.id),/Manual handoff pending/);
});

test("native thread ID is saved during execution, not only on worker exit",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"hs-live-id-"));const store=new TaskStore(root);
 const adapter={capabilities:()=>({headless:true}),run:async({task,onEvent})=>{
  await onEvent({type:"worker.native",harness:"codex",payload:{type:"thread.started",thread_id:"durable-id"}});
  assert.equal((await store.require(task.id)).sessions.codex,"durable-id");
  return {exitCode:0,reason:null,sessionId:"durable-id",output:"done"};
 }};
 await new HarnessSupervisor({store,adapters:{codex:adapter}}).runNew({cwd:root,goal:"x",primary:"codex",fallback:null});
});

test("different store instances cannot run the same workspace concurrently",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"hs-lock-"));const one=new TaskStore(root),two=new TaskStore(root);
 const a=await one.create({cwd:root,goal:"a",primary:"codex"}),b=await two.create({cwd:root,goal:"b",primary:"codex"});
 await one.withTaskLock(a.id,async()=>{
  await assert.rejects(two.withTaskLock(b.id,()=>{}),/Workspace is locked/);
  await assert.rejects(one.unlock(a.id),/still running/);
 });
 await two.withTaskLock(b.id,async()=>{});
});

test("journal failures and cancellation never start fallback",async()=>{
 for(const code of ["JOURNAL_FAILED","cancelled"]){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"hs-no-fallback-"));let called=false;
 const codex={capabilities:()=>({headless:true}),run:async()=>{
  if(code==="JOURNAL_FAILED")throw Object.assign(new Error("disk full"),{code});
  return {exitCode:130,reason:"cancelled",stderr:"cancelled"};
 }};
 const zcode={capabilities:()=>({headless:true}),run:async()=>{called=true;}};
 const {task}=await new HarnessSupervisor({store:new TaskStore(root),adapters:{codex,zcode}}).runNew({cwd:root,goal:"x",primary:"codex",fallback:"zcode"});
 assert.equal(called,false);assert.equal(task.status,code==="cancelled"?"cancelled":"failed");
 }
});
