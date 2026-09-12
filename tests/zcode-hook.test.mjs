import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const bridge = new URL("../zcode-plugin/hooks/bridge.mjs", import.meta.url).pathname;

test("ZCode hook persists event, transcript snapshot, and injects takeover context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-hook-"));
  const sink = path.join(dir, "external-events.jsonl");
  const transcript = path.join(dir, "transcript.jsonl");
  const context = path.join(dir, "context.md");
  await fs.writeFile(transcript, '{"hello":"world"}\n', "utf8");
  await fs.writeFile(context, "continue from durable state", "utf8");

  const input = {
    session_id: "s/1",
    transcript_path: transcript,
    cwd: dir,
    hook_event_name: "SessionStart",
    source: "startup",
    api_key: "secret",
  };

  const output = await runBridge(input, {
    HARNESS_SUPERVISOR_EVENT_SINK: sink,
    HARNESS_SUPERVISOR_CONTEXT_FILE: context,
    ZCODE_PLUGIN_DATA: dir,
  });

  const parsed = JSON.parse(output.trim());
  assert.match(parsed.hookSpecificOutput.additionalContext, /durable state/);
  const event = JSON.parse((await fs.readFile(sink, "utf8")).trim());
  assert.equal(event.payload.api_key, "[REDACTED]");
  assert.equal(await fs.readFile(path.join(dir, "native", "zcode-s_1.jsonl"), "utf8"), '{"hello":"world"}\n');
});

function runBridge(input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridge], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => out += chunk);
    child.stderr.on("data", (chunk) => err += chunk);
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

test("manual desktop session discovers a workspace binding, but another session cannot attach",async()=>{
 const {bindWorkspace,unbindWorkspace}=await import("../zcode-plugin/hooks/bindings.mjs");
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"hs-bound-"));
 const taskDir=path.join(dir,"tasks","task-bound");await fs.mkdir(taskDir,{recursive:true});
 await fs.writeFile(path.join(taskDir,"context.md"),"manual takeover instructions");
 const task={id:"task-bound",cwd:dir};await bindWorkspace(dir,task,taskDir);
 const env={HARNESS_SUPERVISOR_HOME:dir,ZCODE_PLUGIN_DATA:path.join(dir,"plugin"),HARNESS_SUPERVISOR_EVENT_SINK:"",HARNESS_SUPERVISOR_CONTEXT_FILE:""};
 const first=JSON.parse(await runBridge({cwd:dir,session_id:"one",hook_event_name:"SessionStart"},env));
 assert.match(first.hookSpecificOutput.additionalContext,/manual takeover/);
 const second=JSON.parse(await runBridge({cwd:dir,session_id:"two",hook_event_name:"SessionStart"},env));
 assert.deepEqual(second,{});
 await runBridge({cwd:dir,session_id:"one",hook_event_name:"Stop",last_assistant_message:"done"},env);
 const rows=(await fs.readFile(path.join(taskDir,"external-events.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
 assert.deepEqual(rows.map(x=>x.payload.session_id),["one","one"]);
 await unbindWorkspace(dir,task);
});

test('large Chinese context stays below the documented hook output limit', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hs-large-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const context=path.join(dir,'context.md');
  await fs.writeFile(context,'中文交接材料'.repeat(20000));
  const output=await runBridge({hook_event_name:'SessionStart'}, {
    HARNESS_SUPERVISOR_EVENT_SINK:path.join(dir,'events.jsonl'),HARNESS_SUPERVISOR_CONTEXT_FILE:context
  });
  assert.ok(Buffer.byteLength(output)<32768);
  assert.match(JSON.parse(output).hookSpecificOutput.additionalContext,/context.md/);
});
