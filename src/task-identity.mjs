import path from "node:path";

export function taskIdentity(task, state) {
  return {
    taskId: task.id,
    // Legacy directory tasks may have an obsolete initial test prompt as goal.
    title: task.progress?.title ?? task.name ?? (task.worktree ? task.goal : path.basename(task.cwd)),
    goal: task.progress?.goal ?? task.goal,
    cwd: task.cwd,
    worktree: Boolean(task.worktree),
    branch: task.worktree?.branch ?? null,
    status: task.status,
    owner: state?.owner ? { harness: state.owner.harness, sessionId: state.owner.sessionId, active: state.owner.active } : null,
    pending: Boolean(state?.pending),
    runningTools: Object.keys(state?.tools ?? {}).length,
    progressRevision: task.progress?.revision ?? 0,
  };
}

const line = value => String(value ?? "").replace(/\s+/g, " ");
export function identityLine(identity) {
  const owner = identity.owner;
  return `${line(identity.title).slice(0, 60)} · ${identity.worktree ? "worktree/" : "目录/"}${line(path.basename(identity.cwd))} · ${owner ? `${owner.harness} (${owner.active ? "执行中" : "空闲"})` : "尚未认领"}`;
}
