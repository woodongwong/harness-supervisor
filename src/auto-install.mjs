import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { enableWorkspace } from "./auto-handoff.mjs";

const marker = "Harness Relay 自动交接";
const managedMarkers = new Set([marker, "Harness Supervisor 自动交接"]);
const common = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"];
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

export async function installHandoffSkill({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), zcodeHome = path.join(os.homedir(), ".zcode", "cli") } = {}) {
  const source = fileURLToPath(new URL("../zcode-plugin/skills/harness-handoff", import.meta.url));
  const targets = [path.join(codexHome, "skills", "harness-handoff"), path.join(zcodeHome, "..", "skills", "harness-handoff")].map(p => path.resolve(p));
  const missing = [];
  for (const target of targets) {
    try {
      await fs.lstat(target);
      if (await fs.realpath(target) !== await fs.realpath(source)) throw new Error(`已有其他同名 Skill，保留原文件：${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A dangling symlink is also somebody else's existing entry.
      try { await fs.lstat(target); throw new Error(`已有失效的同名 Skill 链接：${target}`); }
      catch (inner) { if (inner.code !== "ENOENT") throw inner; }
      missing.push(target);
    }
  }
  for (const target of missing) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target, "dir");
  }
  return targets;
}

export function hookGroups(harness, root) {
  const script = fileURLToPath(new URL("./auto-hook.mjs", import.meta.url));
  const events = [...common, ...(harness === "codex" ? ["Interrupt", "SessionEnd"] : ["PostToolUseFailure"])];
  return Object.fromEntries(events.map(event => [event, [{ hooks: [harness === "codex" ? {
    type: "command", command: [process.execPath, script, harness, root].map(quote).join(" "),
    timeout: ["Interrupt", "SessionEnd"].includes(event) ? 3 : 60,
    statusMessage: marker,
  } : {
    type: "process", command: process.execPath, args: [script, harness, root], timeoutMs: 60000, enabled: true, statusMessage: marker,
  }] }]]));
}

export async function installAuto({ root, cwd, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), zcodeHome = path.join(os.homedir(), ".zcode", "cli") }) {
  root = path.resolve(root);
  // Parse both files before changing either. Do not print provider credentials.
  const targets = [];
  for (const [harness, file] of [["codex", path.join(codexHome, "hooks.json")], ["zcode", path.join(zcodeHome, "config.json")]]) {
    let raw = null;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const config = raw === null ? {} : JSON.parse(raw);
    if (!config || Array.isArray(config) || typeof config !== "object") throw new Error(`无效配置：${file}`);
    config.hooks ??= {};
    const groups = harness === "codex" ? config.hooks : (config.hooks.events ??= {});
    for (const [event, additions] of Object.entries(hookGroups(harness, root))) {
      const existing = groups[event] ?? [];
      if (!Array.isArray(existing)) throw new Error(`无效 Hook 事件：${file} ${event}`);
      groups[event] = existing.map(group => ({ ...group, hooks: (group.hooks ?? []).filter(h => !managedMarkers.has(h.statusMessage)) }))
        .filter(group => group.hooks.length).concat(additions);
    }
    if (harness === "zcode") config.hooks.enabled = true;
    targets.push({ file, raw, content: JSON.stringify(config, null, 2) + "\n" });
  }
  const skills = await installHandoffSkill({ codexHome, zcodeHome });
  const state = await enableWorkspace(root, cwd);
  const backups = [];
  for (const { file, raw, content } of targets) {
    if (raw === content) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (raw !== null) {
      const backup = `${file}.harness-backup-${crypto.randomUUID()}`;
      await fs.writeFile(backup, raw, { mode: 0o600, flag: "wx" });
      backups.push(backup);
    }
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, content, { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  return { cwd: state.cwd, files: targets.map(t => t.file), skills, backups };
}
