import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { truncate } from "./util.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 2_000_000, timeout: 5000 });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? "") };
  }
}

export async function captureGitState(cwd) {
  const repository = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!repository.ok || repository.stdout.trim() !== "true") {
    return { available: false, head: null, status: "", diff: "", stagedDiff: "", error: "Git 不可用：" + firstError(repository) };
  }
  const [status, diff, staged, head] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--"]),
    git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--stat", "--"]),
    git(cwd, ["rev-parse", "HEAD"]),
  ]);
  return {
    available: true,
    head: head.ok ? head.stdout.trim() : null,
    status: status.ok ? summarizeStatus(status.stdout) : "",
    diff: diff.ok ? truncate(diff.stdout, 3000) : "",
    stagedDiff: staged.ok ? truncate(staged.stdout, 3000) : "",
    error: [status, diff, staged].filter(result => !result.ok).map(firstError).join("；"),
  };
}

export function summarizeStatus(output) {
  const records = output.split("\0");
  const groups = new Map();
  let staged = 0, modified = 0, untracked = 0, conflicts = 0;
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    const code = row.slice(0, 2), file = row.slice(3);
    if (code === "??") untracked++;
    else {
      if (code[0] !== " ") staged++;
      if (code[1] !== " ") modified++;
      if (code.includes("U") || ["AA", "DD"].includes(code)) conflicts++;
    }
    const group = file.includes("/") ? file.split("/")[0] + "/" : file;
    groups.set(group, (groups.get(group) ?? 0) + 1);
    if (/[RC]/.test(code)) i++; // porcelain -z rename/copy has an extra old path.
  }
  if (!groups.size) return "工作区无变更。";
  const counts = `暂存 ${staged} 项；工作区修改 ${modified} 项；未跟踪 ${untracked} 项（目录可合并）；冲突 ${conflicts} 项。`;
  const overview = [...groups].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => `${truncate(name, 80)} ${count} 项`).join("；");
  return `${counts}\n分组：${overview}${groups.size > 8 ? `；另 ${groups.size - 8} 组` : ""}`;
}

function firstError(result) {
  return truncate((result.stderr || "当前目录不是工作树").split(/\r?\n/).find(line => line.trim()) || "未知错误", 180);
}
