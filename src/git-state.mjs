import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { truncate } from "./util.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 2_000_000 });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? "") };
  }
}

export async function captureGitState(cwd) {
  const status = await git(cwd, ["status", "--short"]);
  const diff = await git(cwd, ["diff", "--no-ext-diff", "--"]);
  const staged = await git(cwd, ["diff", "--cached", "--no-ext-diff", "--"]);
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  return {
    head: head.ok ? head.stdout.trim() : null,
    status: truncate(status.stdout || status.stderr, 30_000),
    diff: truncate(diff.stdout || diff.stderr, 100_000),
    stagedDiff: truncate(staged.stdout || staged.stderr, 100_000),
  };
}
