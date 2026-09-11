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
