import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutoHandoff, autoStatus } from "../src/auto-handoff.mjs";

test("explicit completed-history import supplies the next native prompt without claiming ownership", async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "relay-import-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, "state");
  const auto = new AutoHandoff({ root });
  const input = { cwd, goal: "Count records", sourcePath: path.join(cwd, "source.jsonl"),
    sourceText: "The previous session reported 19 projects. This has not been independently verified.",
    checkpoint: { harness: "zcode", sessionId: "session-source", turnId: "turn-source", ended: true,
      startAt: "2026-01-01T00:00:00Z", at: "2026-01-01T00:01:00Z",
      request: "Count records", reply: "19 projects reported by the previous session." } };
  await assert.rejects(auto.importCompletedHandoff({ ...input, checkpoint: { ...input.checkpoint, ended: false } }), /已结束/);
  assert.equal(await autoStatus(root, cwd), null);
  const result = await auto.importCompletedHandoff(input);
  assert.equal((await autoStatus(root, cwd)).owner, null);
  assert.equal((await auto.store.require(result.taskId)).status, "idle");
  assert.equal(await fs.readFile(result.sourceFile, "utf8"), input.sourceText);
  assert.equal((await fs.stat(result.sourceFile)).mode & 0o777, 0o600);
  const before = await autoStatus(root, cwd);
  await assert.rejects(auto.importCompletedHandoff(input), /不能.*覆盖/);
  assert.deepEqual(await autoStatus(root, cwd), before);
  const output = await new AutoHandoff({ root }).handle("codex", { cwd, session_id: "session-target", turn_id: "new-turn",
    hook_event_name: "UserPromptSubmit", prompt: "Continue the ZCode statistics task" });
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /19 projects/);
  assert.match(context, /session-source/);
  assert.match(context, /已导入原生会话结束记录/);
  assert.ok(context.includes(result.sourceFile));
  assert.doesNotMatch(context, /已收到 Stop/);
  assert.equal((await autoStatus(root, cwd)).owner.harness, "codex");
  const records = await auto.store.readEvents(result.taskId);
  assert.equal(records.filter(e => e.type === "task.handoff_imported").length, 1);
  assert.equal(records.filter(e => e.payload?.hook_event_name === "Stop").length, 0);
});
