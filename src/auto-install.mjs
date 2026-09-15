import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { enableWorkspace } from "./auto-handoff.mjs";
import { HARNESS_INTEGRATIONS } from "./harness-integrations.mjs";

const marker = "Harness Relay 自动交接";
const managedMarkers = new Set([marker, "Harness Supervisor 自动交接"]);
const common = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"];
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

export async function installHandoffSkill({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), zcodeHome = path.join(os.homedir(), ".zcode", "cli"), codebuddyHome = process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".codebuddy"), harnesses = ["codex", "zcode"] } = {}) {
  validateHarnesses(harnesses);
  const homes = { codex: codexHome, zcode: path.resolve(zcodeHome, ".."), codebuddy: codebuddyHome };
  const entries = ["harness-handoff", "harness-finish"].flatMap(name => [...new Set(harnesses)].map(h => ({
    source: fileURLToPath(new URL(`../zcode-plugin/skills/${name}`, import.meta.url)),
    target: path.resolve(homes[h], "skills", name),
  })));
  const missing = [];
  for (const { target, source } of entries) {
    try {
      await fs.lstat(target);
      if (await fs.realpath(target) !== await fs.realpath(source)) throw new Error(`已有其他同名 Skill，保留原文件：${target}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // A dangling symlink is also somebody else's existing entry.
      try { await fs.lstat(target); throw new Error(`已有失效的同名 Skill 链接：${target}`); }
      catch (inner) { if (inner.code !== "ENOENT") throw inner; }
      missing.push({ target, source });
    }
  }
  for (const { target, source } of missing) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target, "dir");
  }
  return entries.map(e => e.target);
}

export function hookGroups(harness, root) {
  const script = fileURLToPath(new URL("./auto-hook.mjs", import.meta.url));
  validateHarnesses([harness]);
  const events = [...common, ...(harness === "codex" ? ["Interrupt", "SessionEnd"] : harness === "codebuddy" ? ["PostToolUseFailure", "SessionEnd"] : ["PostToolUseFailure"])];
  return Object.fromEntries(events.map(event => [event, [{ hooks: [harness !== "zcode" ? {
    type: "command", command: [process.execPath, script, harness, root].map(quote).join(" "),
    timeout: ["Interrupt", "SessionEnd"].includes(event) ? 3 : 60,
    statusMessage: marker,
  } : {
    type: "process", command: process.execPath, args: [script, harness, root], timeoutMs: 60000, enabled: true, statusMessage: marker,
  }] }]]));
}

function validateHarnesses(harnesses) {
  if (!Array.isArray(harnesses) || !harnesses.length || harnesses.some(h => !Object.hasOwn(HARNESS_INTEGRATIONS, h))) {
    throw new Error("Unknown harness integration");
  }
}

export async function installAuto({ root, cwd, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), zcodeHome = path.join(os.homedir(), ".zcode", "cli"), codebuddyHome = process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), ".codebuddy"), harnesses = ["codex", "zcode"] }) {
  root = path.resolve(root);
  validateHarnesses(harnesses);
  // Parse all selected files before changing any. Do not print credentials.
  const targets = [];
  const files = { codex: path.join(codexHome, "hooks.json"), zcode: path.join(zcodeHome, "config.json"), codebuddy: path.join(codebuddyHome, "settings.json") };
  for (const harness of new Set(harnesses)) {
    const file = files[harness];
    let raw = null;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const config = raw === null ? {} : JSON.parse(raw);
    if (!config || Array.isArray(config) || typeof config !== "object") throw new Error(`无效配置：${file}`);
    config.hooks ??= {};
    const groups = harness !== "zcode" ? config.hooks : (config.hooks.events ??= {});
    for (const [event, additions] of Object.entries(hookGroups(harness, root))) {
      const existing = groups[event] ?? [];
      if (!Array.isArray(existing)) throw new Error(`无效 Hook 事件：${file} ${event}`);
      groups[event] = existing.map(group => ({ ...group, hooks: (group.hooks ?? []).filter(h => !managedMarkers.has(h.statusMessage)) }))
        .filter(group => group.hooks.length).concat(additions);
    }
    if (harness === "zcode") config.hooks.enabled = true;
    targets.push({ file, raw, content: JSON.stringify(config, null, 2) + "\n" });
  }
  const skills = await installHandoffSkill({ codexHome, zcodeHome, codebuddyHome, harnesses });
  const state = cwd ? await enableWorkspace(root, cwd) : null;
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
  return { cwd: state?.cwd ?? null, files: targets.map(t => t.file), skills, backups };
}
