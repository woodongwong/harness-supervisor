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
