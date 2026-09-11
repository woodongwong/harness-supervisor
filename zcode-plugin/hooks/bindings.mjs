import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export function supervisorHome() {
  return process.env.HARNESS_SUPERVISOR_HOME || path.join(os.homedir(), ".harness-supervisor");
}

async function bindingPath(root, cwd) {
  const canonical = await fs.realpath(cwd);
  const key = crypto.createHash("sha256").update(canonical).digest("hex");
  return path.join(root, "bindings", `${key}.json`);
}

export async function bindWorkspace(root, task, taskDir) {
  const file = await bindingPath(root, task.cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, "wx", 0o600).catch((error) => {
    if (error.code === "EEXIST") throw new Error("Workspace already bound; unbind its old task before binding a new session");
    throw error;
  });
  try { await handle.writeFile(JSON.stringify({ taskId: task.id, taskDir: path.resolve(taskDir) })); }
  finally { await handle.close(); }
  return file;
}

export async function unbindWorkspace(root, task) {
  const file = await bindingPath(root, task.cwd);
  const binding = JSON.parse(await fs.readFile(file, "utf8"));
  if (binding.taskId !== task.id) throw new Error("Workspace is bound to another task");
  await fs.rm(`${file}.session`, { force: true });
  await fs.unlink(file);
}

export async function resolveBinding(input) {
  if (!input.cwd) return null;
  let file, binding;
  try {
    file = await bindingPath(supervisorHome(), input.cwd);
    binding = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const session = input.session_id ?? input.sessionId;
  if (!session) return null;
  const sessionFile = `${file}.session`;
  const hook = input.hook_event_name ?? input.hookEventName;
  if (hook === "SessionStart") {
    try { await fs.writeFile(sessionFile, String(session), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  try { if ((await fs.readFile(sessionFile, "utf8")) !== String(session)) return null; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  return binding;
}

export async function assertWorkspaceUnbound(root, cwd) {
  const file = await bindingPath(root, cwd);
  let binding;
  try { binding = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error(`Workspace is bound to ZCode task ${binding.taskId}. Stop ZCode, then run unbind-zcode ${binding.taskId} before starting another worker.`);
}
