import { CodexAdapter } from "./adapters/codex.mjs";
import { ZCodeAdapter } from "./adapters/zcode.mjs";
import { captureGitState } from "./git-state.mjs";
import { TaskStore } from "./store.mjs";
import { nowIso, truncate } from "./util.mjs";

const RECOVERABLE = new Set(["quota", "auth", "transport", "process"]);

export class HarnessSupervisor {
  constructor({ store = new TaskStore(), adapters = null } = {}) {
    this.store = store;
    this.adapters = adapters ?? { codex: new CodexAdapter(), zcode: new ZCodeAdapter() };
  }

  capabilities() {
    return Object.fromEntries(Object.entries(this.adapters).map(([name, adapter]) => [name, adapter.capabilities()]));
  }

  async createTask({ goal, cwd, primary = "codex", fallback = "zcode" }) {
    this.#adapter(primary);
    if (fallback) this.#adapter(fallback);
    if (fallback === primary) throw new Error("primary and fallback must differ");
    return await this.store.create({ goal, cwd, primary, fallback });
  }

  async runNew(input) {
    const task = await this.createTask(input);
    return await this.run(task.id);
  }

  async run(taskId) {
    const task = await this.store.require(taskId);
    return await this.#runHarness(task, task.primary, { allowFallback: true });
  }

  async takeover(taskId, toHarness, feedback = "") {
    const task = await this.store.require(taskId);
    this.#adapter(toHarness);
    await this.store.appendEvent(task.id, {
      type: "task.takeover.requested",
      from: task.owner,
      to: toHarness,
      feedback: truncate(feedback, 20_000),
    });
    return await this.#runHarness(task, toHarness, { allowFallback: false, feedback });
  }

  async #runHarness(task, harness, { allowFallback, feedback = "" }) {
    const adapter = this.#adapter(harness);
    task.owner = harness;
    task.status = "running";
    task.generation += 1;
    task.error = null;
    const attempt = {
      harness,
      generation: task.generation,
      startedAt: nowIso(),
      endedAt: null,
      sessionId: task.sessions[harness] ?? null,
      exitCode: null,
      reason: null,
    };
    task.attempts.push(attempt);
    await this.store.save(task);

    const prompt = task.generation === 1 && !feedback
      ? buildInitialPrompt(task)
      : await this.#buildHandoffPrompt(task, harness, feedback);
    await this.store.writeContext(task.id, prompt);
    await this.store.appendEvent(task.id, {
      type: "worker.started",
      harness,
      generation: task.generation,
      resumeSessionId: attempt.sessionId,
    });

    let result;
    try {
      result = await adapter.run({
        task,
        prompt,
        resumeSessionId: attempt.sessionId,
        taskDir: this.store.taskDir(task.id),
        contextPath: this.store.contextPath(task.id),
        externalEventsPath: this.store.externalEventsPath(task.id),
        onEvent: async (event) => this.store.appendEvent(task.id, event),
      });
    } catch (error) {
      result = {
        exitCode: 1,
        signal: null,
        sessionId: attempt.sessionId,
        output: "",
        stderr: String(error?.stack ?? error),
        reason: "process",
      };
    }

    attempt.endedAt = nowIso();
    attempt.sessionId = result.sessionId ?? attempt.sessionId;
    attempt.exitCode = result.exitCode;
    attempt.reason = result.reason;
    if (attempt.sessionId) task.sessions[harness] = attempt.sessionId;

    await this.store.appendEvent(task.id, {
      type: "worker.finished",
      harness,
      exitCode: result.exitCode,
      signal: result.signal,
      sessionId: result.sessionId,
      reason: result.reason,
      output: truncate(result.output, 40_000),
      stderr: truncate(result.stderr, 20_000),
    });

    if (result.exitCode === 0 && !result.reason) {
      task.status = "completed";
      task.error = null;
      await this.store.save(task);
      return { task, result };
    }

    task.status = result.reason === "quota" ? "worker_unavailable" : "failed";
    task.error = result.stderr || result.reason || `exit ${result.exitCode}`;
    await this.store.save(task);

    if (allowFallback && task.fallback && task.fallback !== harness && RECOVERABLE.has(result.reason)) {
      await this.store.appendEvent(task.id, {
        type: "worker.failover",
        from: harness,
        to: task.fallback,
        reason: result.reason,
      });
      return await this.#runHarness(task, task.fallback, {
        allowFallback: false,
        feedback: `Previous ${harness} worker stopped with reason: ${result.reason}. Continue the same task.`,
      });
    }

    return { task, result };
  }

  async #buildHandoffPrompt(task, targetHarness, feedback) {
    const [events, git] = await Promise.all([
      this.store.readEvents(task.id, { limit: 60, includeExternal: true }),
      captureGitState(task.cwd),
    ]);
    const compactEvents = events.map((event) => summarizeEvent(event)).filter(Boolean).join("\n");
    return `You are taking over an existing coding task from another native harness.\n\nTask ID: ${task.id}\nTarget harness: ${targetHarness}\nGoal:\n${task.goal}\n\n`
      + (feedback ? `Takeover note:\n${feedback}\n\n` : "")
      + `Rules:\n- Treat the workspace and Git state as source of truth.\n- Do not redo work already present unless verification shows it is wrong.\n- Inspect changes and tests before continuing.\n- Do not assume the previous harness finished cleanly.\n\nRecent durable journal:\n${truncate(compactEvents, 70_000)}\n\nGit HEAD: ${git.head ?? "unknown"}\nGit status:\n${git.status || "(clean or unavailable)"}\n\nUnstaged diff:\n${git.diff || "(none)"}\n\nStaged diff:\n${git.stagedDiff || "(none)"}\n`;
  }

  #adapter(name) {
    const adapter = this.adapters[name];
    if (!adapter) throw new Error(`Unsupported harness: ${name}`);
    return adapter;
  }
}

function buildInitialPrompt(task) {
  return `Task ID: ${task.id}\n\n${task.goal}\n\nWork directly in the current workspace. Preserve existing unrelated changes. Verify your work with relevant tests when possible.`;
}

function summarizeEvent(event) {
  const prefix = `[${event.at ?? ""}] ${event.type ?? "event"}`;
  if (event.type === "worker.native") {
    const p = event.payload ?? {};
    if (event.harness === "codex") {
      if (p.type === "item.completed") {
        const item = p.item ?? {};
        if (item.type === "agent_message") return `${prefix} codex agent: ${truncate(item.text, 8_000)}`;
        if (item.type === "command_execution") return `${prefix} codex command: ${truncate(item.command, 3_000)} => exit=${item.exit_code}`;
        if (item.type === "file_change") return `${prefix} codex file changes: ${JSON.stringify(item.changes ?? [])}`;
      }
      if (p.type === "turn.failed" || p.type === "error") {
        return `${prefix} codex error: ${truncate(p?.error?.message ?? p.message ?? JSON.stringify(p), 5_000)}`;
      }
      return null;
    }
    if (event.harness === "zcode" && p.text) return `${prefix} zcode stdout: ${truncate(p.text, 4_000)}`;
  }

  if (event.source === "zcode-hook") {
    const p = event.payload ?? {};
    const hook = p.hook_event_name ?? p.hookEventName;
    if (hook === "PreToolUse") return `${prefix} zcode PreToolUse ${p.tool_name ?? ""}: ${truncate(JSON.stringify(p.tool_input ?? {}), 5_000)}`;
    if (hook === "PostToolUse") return `${prefix} zcode PostToolUse ${p.tool_name ?? ""}: ${truncate(JSON.stringify(p.tool_response ?? {}), 5_000)}`;
    if (hook === "PostToolUseFailure") return `${prefix} zcode tool failure ${p.tool_name ?? ""}: ${truncate(p.error, 5_000)}`;
    if (hook === "Stop") return `${prefix} zcode stop: ${truncate(p.last_assistant_message ?? "", 8_000)}`;
    if (hook === "UserPromptSubmit") return `${prefix} zcode prompt: ${truncate(p.prompt ?? "", 4_000)}`;
    if (hook === "SessionStart") return `${prefix} zcode session ${p.session_id ?? p.sessionId ?? ""} started`;
  }

  if (["worker.started", "worker.finished", "worker.failover", "task.takeover.requested"].includes(event.type)) {
    return `${prefix} ${truncate(JSON.stringify(event), 5_000)}`;
  }
  return null;
}
