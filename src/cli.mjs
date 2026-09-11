#!/usr/bin/env node
import process from "node:process";
import { HarnessSupervisor } from "./supervisor.mjs";

const supervisor = new HarnessSupervisor();

function parse(argv) {
  const [command, ...rest] = argv;
  const values = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (!item.startsWith("--")) {
      values._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = rest[i + 1];
    values[key] = next && !next.startsWith("--") ? (i++, next) : true;
  }
  return { command, values };
}

function usage() {
  console.log(`harness-supervisor\n\n  run --cwd <repo> --task <text> [--primary codex|zcode] [--fallback codex|zcode|none]\n  takeover <task-id> --to codex|zcode [--feedback <text>]\n  status <task-id>\n  capabilities\n\nEnvironment:\n  HARNESS_SUPERVISOR_HOME\n  CODEX_BIN\n  CODEX_SUPERVISOR_ARGS_JSON\n  ZCODE_BIN\n  ZCODE_SUPERVISOR_ARGS_JSON\n  ZCODE_SUPERVISOR_RESUME_ARGS_JSON\n`);
}

const { command, values } = parse(process.argv.slice(2));

try {
  if (command === "run") {
    if (!values.cwd || !values.task) throw new Error("run requires --cwd and --task");
    const fallback = values.fallback === "none" ? null : (values.fallback ?? "zcode");
    const { task, result } = await supervisor.runNew({
      cwd: values.cwd,
      goal: values.task,
      primary: values.primary ?? "codex",
      fallback,
    });
    console.log(JSON.stringify({ task, result }, null, 2));
    process.exitCode = task.status === "completed" ? 0 : 1;
  } else if (command === "takeover") {
    const id = values._[0];
    if (!id || !values.to) throw new Error("takeover requires <task-id> --to <harness>");
    const { task, result } = await supervisor.takeover(id, values.to, values.feedback ?? "");
    console.log(JSON.stringify({ task, result }, null, 2));
    process.exitCode = task.status === "completed" ? 0 : 1;
  } else if (command === "status") {
    const id = values._[0];
    if (!id) throw new Error("status requires <task-id>");
    const task = await supervisor.store.require(id);
    const events = await supervisor.store.readEvents(id, { limit: 20, includeExternal: true });
    console.log(JSON.stringify({ task, events }, null, 2));
  } else if (command === "capabilities") {
    console.log(JSON.stringify(supervisor.capabilities(), null, 2));
  } else {
    usage();
    if (command) process.exitCode = 2;
  }
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
}
