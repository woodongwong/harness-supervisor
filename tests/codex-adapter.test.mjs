import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAdapter } from "../src/adapters/codex.mjs";

function fakeSpawn(events, { exitCode = 0, stderr = "" } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

test("Codex adapter captures native thread id and final message", async () => {
  const adapter = new CodexAdapter({
    spawnImpl: fakeSpawn([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "item.completed", item: { id: "x", type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ]),
  });
  const seen = [];
  const result = await adapter.run({ task: { cwd: process.cwd() }, prompt: "hi", onEvent: async (event) => seen.push(event) });
  assert.equal(result.sessionId, "thread-1");
  assert.equal(result.output, "done");
  assert.equal(result.reason, null);
  assert.ok(seen.some((event) => event.payload?.type === "thread.started"));
});

test("Codex adapter classifies quota exhaustion", async () => {
  const adapter = new CodexAdapter({
    spawnImpl: fakeSpawn([
      { type: "thread.started", thread_id: "thread-2" },
      { type: "turn.failed", error: { message: "You've hit your usage limit" } },
    ], { exitCode: 1 }),
  });
  const result = await adapter.run({ task: { cwd: process.cwd() }, prompt: "hi" });
  assert.equal(result.reason, "quota");
});

test("waits for ordered async journal writes before returning", async () => {
  const adapter = new CodexAdapter({ spawnImpl: fakeSpawn([
    { type: "thread.started", thread_id: "slow" },
    { type: "turn.completed" },
  ]) });
  const seen = [];
  await adapter.run({ task: { cwd: process.cwd() }, prompt: "hi", onEvent: async (e) => {
    await new Promise(r => setTimeout(r, 15)); seen.push(e.payload.type);
  } });
  assert.deepEqual(seen, ["thread.started", "turn.completed"]);
});

test("journal write failure is not swallowed as unparsed stdout", async () => {
  const adapter = new CodexAdapter({ spawnImpl: fakeSpawn([{ type: "thread.started", thread_id: "x" }]) });
  await assert.rejects(adapter.run({ task: { cwd: process.cwd() }, prompt: "hi", onEvent: async () => {
    throw new Error("disk full");
  } }), /Event journal failed: disk full/);
});

test("collects stdout arriving after exit, including final unterminated line", async () => {
  const adapter = new CodexAdapter({ spawnImpl: () => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    setImmediate(() => {
      c.emit("exit", 0, null);
      c.stdout.end(JSON.stringify({type: "item.completed", item: {type: "agent_message", text: "late"}}));
      c.stderr.end(); c.emit("close", 0, null);
    }); return c;
  } });
  const result = await adapter.run({task:{cwd:process.cwd()}, prompt:"hi"});
  assert.equal(result.output, "late");
});

test("failed turn is failure even with zero process exit", async () => {
  const adapter = new CodexAdapter({spawnImpl:fakeSpawn([{type:"turn.failed",error:{message:"model stopped"}}])});
  const result = await adapter.run({task:{cwd:process.cwd()},prompt:"hi"});
  assert.equal(result.reason,"process");
});

test('successful retry does not trigger failover from earlier error', async () => {
  const adapter=new CodexAdapter({spawnImpl:fakeSpawn([
    {type:'error',message:'connection reset, retrying'}, {type:'turn.completed'}
  ],{stderr:'temporary connection reset'})});
  assert.equal((await adapter.run({task:{cwd:process.cwd()},prompt:'hi'})).reason,null);
});

test('abort stops a real running subprocess', {timeout:10000}, async () => {
  const {spawn}=await import('node:child_process');
  const {runChild}=await import('../src/adapters/codex.mjs');
  const controller=new AbortController();
  const result=await runChild({binary:process.execPath,args:['-e',`console.log('ready');setInterval(()=>{},1000)`],
    cwd:process.cwd(),env:process.env,spawnImpl:spawn,parseJsonLines:false,signal:controller.signal,
    onNativeEvent:async()=>controller.abort()});
  assert.equal(result.reason,'cancelled');
  assert.notEqual(result.exitCode,0);
});
