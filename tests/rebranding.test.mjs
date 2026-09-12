import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { relayHome, relayEnv } from "../zcode-plugin/hooks/runtime-config.mjs";
import { installAuto } from "../src/auto-install.mjs";
import { CodexAdapter } from "../src/adapters/codex.mjs";
import { ZCodeAdapter } from "../src/adapters/zcode.mjs";
import { HarnessRelay, HarnessSupervisor } from "../src/supervisor.mjs";

test("new installations use the Relay directory while old stores and environment overrides remain compatible", () => {
  const options = { home: "/home/test", env: {}, exists: () => false };
  assert.equal(relayHome(options), "/home/test/.harness-relay");
  assert.equal(relayHome({ ...options, exists: () => true }), "/home/test/.harness-supervisor");
  assert.equal(relayHome({ ...options, env: { HARNESS_SUPERVISOR_HOME: "/old" } }), "/old");
  assert.equal(relayHome({ ...options, env: { HARNESS_SUPERVISOR_HOME: "/old", HARNESS_RELAY_HOME: "/new" } }), "/new");
  assert.equal(relayEnv("EVENT_SINK", { HARNESS_RELAY_EVENT_SINK: "/new", HARNESS_SUPERVISOR_EVENT_SINK: "/old" }), "/new");
  assert.equal(relayEnv("EVENT_SINK", { HARNESS_SUPERVISOR_EVENT_SINK: "/old" }), "/old");
  assert.equal(HarnessRelay, HarnessSupervisor);
});

test("launcher arguments accept legacy names and prioritize the Relay equivalents", t => {
  const keys = ["CODEX_RELAY_ARGS_JSON", "CODEX_SUPERVISOR_ARGS_JSON", "ZCODE_RELAY_ARGS_JSON", "ZCODE_SUPERVISOR_ARGS_JSON", "ZCODE_RELAY_RESUME_ARGS_JSON", "ZCODE_SUPERVISOR_RESUME_ARGS_JSON"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; });
  for (const key of keys) delete process.env[key];
  process.env.CODEX_SUPERVISOR_ARGS_JSON = '["--old"]';
  process.env.ZCODE_SUPERVISOR_ARGS_JSON = '["old"]';
  process.env.ZCODE_SUPERVISOR_RESUME_ARGS_JSON = '["old-resume"]';
  assert.deepEqual(new CodexAdapter().extraArgs, ["--old"]);
  assert.deepEqual(new ZCodeAdapter().argsTemplate, ["old"]);
  assert.deepEqual(new ZCodeAdapter().resumeArgsTemplate, ["old-resume"]);
  process.env.CODEX_RELAY_ARGS_JSON = '["--new"]';
  process.env.ZCODE_RELAY_ARGS_JSON = '["new"]';
  process.env.ZCODE_RELAY_RESUME_ARGS_JSON = '["new-resume"]';
  assert.deepEqual(new CodexAdapter().extraArgs, ["--new"]);
  assert.deepEqual(new ZCodeAdapter().argsTemplate, ["new"]);
  assert.deepEqual(new ZCodeAdapter().resumeArgsTemplate, ["new-resume"]);
});

test("upgrading legacy managed hooks replaces them once and preserves unrelated hooks", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-rename-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const codexHome = path.join(dir, "codex"), zcodeHome = path.join(dir, "zcode", "cli");
  const legacy = { hooks: [{ statusMessage: "Harness Supervisor 自动交接", command: "old-path" }, { command: "unrelated-hook" }] };
  await fs.mkdir(codexHome, { recursive: true }); await fs.mkdir(zcodeHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [legacy] } }));
  await fs.writeFile(path.join(zcodeHome, "config.json"), JSON.stringify({ hooks: { events: { PreToolUse: [legacy] } } }));
  const options = { root: path.join(dir, "state"), cwd: dir, codexHome, zcodeHome };
  await installAuto(options); await installAuto(options);
  for (const [file, nested] of [[path.join(codexHome, "hooks.json"), false], [path.join(zcodeHome, "config.json"), true]]) {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    const groups = nested ? data.hooks.events : data.hooks;
    const hooks = groups.PreToolUse.flatMap(group => group.hooks);
    assert.equal(hooks.filter(hook => hook.statusMessage === "Harness Relay 自动交接").length, 1);
    assert.ok(hooks.some(hook => hook.command === "unrelated-hook"));
    assert.ok(hooks.every(hook => hook.command !== "old-path"));
  }
});

test("a copied standalone bridge accepts Relay environment names and does not write to the legacy sink", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-plugin-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const plugin = path.join(dir, "plugin");
  await fs.cp(new URL("../zcode-plugin/", import.meta.url), plugin, { recursive: true });
  const context = path.join(dir, "context.md"), sink = path.join(dir, "events.jsonl"), oldSink = path.join(dir, "old.jsonl");
  await fs.writeFile(context, "CONTINUE_RELAY_TASK");
  const result = spawnSync(process.execPath, [path.join(plugin, "hooks", "bridge.mjs")], {
    cwd: dir, encoding: "utf8", input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "test", cwd: dir }),
    env: { ...process.env, HARNESS_RELAY_EVENT_SINK: sink, HARNESS_RELAY_CONTEXT_FILE: context, HARNESS_SUPERVISOR_EVENT_SINK: oldSink, HARNESS_SUPERVISOR_CONTEXT_FILE: "/absent" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /CONTINUE_RELAY_TASK/);
  assert.equal(JSON.parse((await fs.readFile(sink, "utf8")).trim()).payload.session_id, "test");
  await assert.rejects(fs.access(oldSink), { code: "ENOENT" });
});
