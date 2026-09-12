import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { AutoHandoff, autoStatus, enableWorkspace } from "../src/auto-handoff.mjs";
import { installAuto } from "../src/auto-install.mjs";

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hs-auto-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "state");
  await enableWorkspace(root, dir);
  const auto = new AutoHandoff({ root, waitMs: 1000 });
  const input = (session, hook, extra = {}) => ({ cwd: dir, session_id: session, hook_event_name: hook, ...extra });
  return { dir, root, auto, input };
}

test("normal messages transfer both directions, opening windows does not, stale events do not reclaim", async t => {
  const { dir, root, auto, input } = await fixture(t);
  await auto.handle("codex", input("c", "UserPromptSubmit", { prompt: "修复边界问题", turn_id: "one" }));
  const id = (await autoStatus(root, dir)).taskId;
  await auto.handle("zcode", input("z", "SessionStart"));
  assert.equal((await autoStatus(root, dir)).owner.key, "codex:c");
  await auto.handle("codex", input("c", "Stop", { turn_id: "one", last_assistant_message: "已完成设计" }));
  const takeover = await auto.handle("zcode", input("z", "UserPromptSubmit", { prompt: "按方案实现" }));
  assert.match(takeover.hookSpecificOutput.additionalContext, /已完成设计/);
  assert.equal((await autoStatus(root, dir)).taskId, id);
  const stale = await auto.handle("codex", input("c", "PreToolUse", { tool_use_id: "old", turn_id: "one" }));
  assert.equal(stale.hookSpecificOutput.permissionDecision, "deny");
  await auto.handle("codex", input("c", "Stop", { turn_id: "one" }));
  assert.equal((await autoStatus(root, dir)).owner.active, true);
  await auto.handle("zcode", input("z", "Stop", { last_assistant_message: "已完成实现" }));
  const back = await auto.handle("codex", input("c", "UserPromptSubmit", { turn_id: "two", prompt: "检查结果" }));
  assert.match(back.hookSpecificOutput.additionalContext, /已完成实现/);
  await auto.handle("codex", input("c", "Stop", { turn_id: "one" }));
  assert.equal((await autoStatus(root, dir)).owner.active, true);
});

test("pending handoff fences old tools and waits for both tool completion and stop", async t => {
  const { dir, root, auto, input } = await fixture(t);
  await auto.handle("codex", input("c", "UserPromptSubmit", { prompt: "work" }));
  await auto.handle("codex", input("c", "PreToolUse", { tool_use_id: "running", tool_name: "Bash" }));
  let finished = false;
  const pending = auto.handle("zcode", input("z", "UserPromptSubmit", { prompt: "continue" })).then(v => { finished = true; return v; });
  while (!(await autoStatus(root, dir)).pending) await delay(10);
  const blocked = await auto.handle("codex", input("c", "PreToolUse", { tool_use_id: "another" }));
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  await auto.handle("codex", input("c", "Stop"));
  await delay(130);
  assert.equal(finished, false);
  await auto.handle("codex", input("c", "PostToolUse", { tool_use_id: "running", tool_response: "done" }));
  assert.ok((await pending).hookSpecificOutput.additionalContext);
  assert.equal((await autoStatus(root, dir)).owner.key, "zcode:z");
});

test("timeout never steals ownership and parallel request cannot replace pending claimant", async t => {
  const { dir, root, input } = await fixture(t);
  const auto = new AutoHandoff({ root, waitMs: 200 });
  await auto.handle("zcode", input("z", "UserPromptSubmit", { prompt: "work" }));
  const pending = auto.handle("codex", input("c", "UserPromptSubmit"));
  while (!(await autoStatus(root, dir)).pending) await delay(10);
  assert.equal((await auto.handle("codex", input("other", "UserPromptSubmit"))).continue, false);
  const output = await pending;
  assert.equal(output.continue, false);
  assert.equal(output.decision, "block");
  assert.equal((await autoStatus(root, dir)).owner.key, "zcode:z");
  assert.equal((await autoStatus(root, dir)).pending, null);
});

test("installer preserves unrelated configuration, keeps backups and is idempotent", async t => {
  const { dir, root } = await fixture(t);
  const codexHome = path.join(dir, "codex");
  const zcodeHome = path.join(dir, "zcode");
  await fs.mkdir(codexHome); await fs.mkdir(zcodeHome);
  const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-command" }] }] } };
  await fs.writeFile(path.join(codexHome, "hooks.json"), JSON.stringify(original));
  await fs.writeFile(path.join(zcodeHome, "config.json"), JSON.stringify({ model: "existing-model", secret: "test-secret" }));
  const first = await installAuto({ root, cwd: dir, codexHome, zcodeHome });
  assert.equal(first.backups.length, 2);
  const second = await installAuto({ root, cwd: dir, codexHome, zcodeHome });
  assert.equal(second.backups.length, 0);
  const config = JSON.parse(await fs.readFile(path.join(codexHome, "hooks.json")));
  assert.equal(config.hooks.Stop.length, 2);
  assert.equal(config.hooks.Stop[0].hooks[0].command, "existing-command");
  const zconfig = JSON.parse(await fs.readFile(path.join(zcodeHome, "config.json")));
  assert.equal(zconfig.model, "existing-model");
  assert.equal(zconfig.secret, "test-secret");
  assert.equal(zconfig.hooks.enabled, true);
});

function bridge(root, harness, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("../src/auto-hook.mjs", import.meta.url).pathname, harness, root]);
    let stdout = "", stderr = "";
    child.stdout.on("data", c => stdout += c);
    child.stderr.on("data", c => stderr += c);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(input));
  });
}

test("independent hook processes share the journal and only enabled projects participate", async t => {
  const { dir, root, input } = await fixture(t);
  const other = path.join(dir, "other"); await fs.mkdir(other);
  assert.deepEqual(await bridge(root, "codex", { cwd: other, session_id: "ignored", hook_event_name: "UserPromptSubmit" }), {});
  await bridge(root, "codex", input("c", "UserPromptSubmit", { prompt: "native process" }));
  await bridge(root, "codex", input("c", "Stop", { last_assistant_message: "persisted result" }));
  const output = await bridge(root, "zcode", input("z", "UserPromptSubmit", { prompt: "continue" }));
  assert.match(output.hookSpecificOutput.additionalContext, /persisted result/);
  assert.equal((await autoStatus(root, dir)).owner.key, "zcode:z");
});
