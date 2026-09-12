import { assertWorkspaceUnbound } from "../zcode-plugin/hooks/bindings.mjs";
import { CodexAdapter } from "./adapters/codex.mjs";
import { ZCodeAdapter } from "./adapters/zcode.mjs";
import { captureGitState } from "./git-state.mjs";
import { buildHandoffContext } from "./handoff-context.mjs";
import { TaskStore } from "./store.mjs";
import { nowIso, truncate } from "./util.mjs";

const RECOVERABLE = new Set(["quota", "auth", "transport", "process"]);

export class HarnessRelay {
  constructor({ store = new TaskStore(), adapters = null, signal = null } = {}) {
    this.store = store;
    this.adapters = adapters ?? { codex: new CodexAdapter(), zcode: new ZCodeAdapter() };
    this.signal = signal;
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
    return this.store.withTaskLock(taskId, async () => {
      const task = await this.store.require(taskId);
      if (task.status === "awaiting_manual") throw new Error("Manual handoff pending; use takeover explicitly after stopping that worker");
      return this.#runHarness(task, task.owner ?? task.primary, { allowFallback: true });
    });
  }

  async takeover(taskId, toHarness, feedback = "") {
    return this.store.withTaskLock(taskId, async () => {
      const task = await this.store.require(taskId);
      this.#adapter(toHarness);
      await this.store.appendEvent(task.id, {
        type: "task.takeover.requested",
        from: task.owner,
        to: toHarness,
        feedback: truncate(feedback, 20_000),
    });
    return await this.#runHarness(task, toHarness, { allowFallback: false, feedback });
    });
  }

  async #runHarness(task, harness, { allowFallback, feedback = "" }) {
    await assertWorkspaceUnbound(this.store.root, task.cwd);
    const adapter = this.#adapter(harness);
    if (this.signal?.aborted) throw new Error("Cancelled before worker start");
    if (!adapter.capabilities().headless) {
      const prompt = await this.#buildHandoffPrompt(task, harness, feedback);
      await this.store.writeContext(task.id, prompt);
      task.owner = harness;
      task.status = "awaiting_manual";
      task.error = null;
      await this.store.save(task);
      await this.store.appendEvent(task.id, { type: "task.manual_handoff", harness });
      return { task, result: {
        exitCode: null, reason: "manual_handoff_required", sessionId: null,
        output: `Open ${task.cwd} in ZCode and supply ${this.store.contextPath(task.id)}. Run bind-zcode ${task.id} before starting a new session to enable the bridge.`,
        contextPath: this.store.contextPath(task.id),
      } };
    }
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
        signal: this.signal,
        onEvent: async (event) => {
          await this.store.appendEvent(task.id, event);
          const id = event.payload?.type === "thread.started" ? event.payload.thread_id : null;
          if (id) {
            task.sessions[harness] = id;
            attempt.sessionId = id;
            await this.store.save(task);
          }
        },
      });
    } catch (error) {
      result = {
        exitCode: 1,
        signal: null,
        sessionId: attempt.sessionId,
        output: "",
        stderr: String(error?.stack ?? error),
        reason: error.code === "JOURNAL_FAILED" ? "journal" : "process",
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

    task.status = result.reason === "cancelled" ? "cancelled" : result.reason === "quota" ? "worker_unavailable" : "failed";
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
    return buildHandoffContext({ task, events, git, taskDir: this.store.taskDir(task.id), target: targetHarness, feedback });
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

// Preserve the original module API for existing integrations.
export { HarnessRelay as HarnessSupervisor };
