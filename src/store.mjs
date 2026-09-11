import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { newTaskId, nowIso } from "./util.mjs";

export class TaskStore {
  constructor(root = process.env.HARNESS_SUPERVISOR_HOME ?? path.join(os.homedir(), ".harness-supervisor")) {
    this.root = path.resolve(root);
    this.tasksDir = path.join(this.root, "tasks");
    this.queues = new Map();
  }

  async initialize() {
    await fs.mkdir(this.tasksDir, { recursive: true });
  }

  taskDir(id) { return path.join(this.tasksDir, id); }
  statePath(id) { return path.join(this.taskDir(id), "task.json"); }
  eventsPath(id) { return path.join(this.taskDir(id), "events.jsonl"); }
  externalEventsPath(id) { return path.join(this.taskDir(id), "external-events.jsonl"); }
  contextPath(id) { return path.join(this.taskDir(id), "context.md"); }

  async create({ goal, cwd, primary, fallback }) {
    await this.initialize();
    const id = newTaskId();
    const now = nowIso();
    const task = {
      version: 1,
      id,
      goal: String(goal).trim(),
      cwd: path.resolve(cwd),
      status: "created",
      owner: null,
      primary,
      fallback: fallback ?? null,
      generation: 0,
      sessions: { codex: null, zcode: null },
      attempts: [],
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    await fs.mkdir(this.taskDir(id), { recursive: true });
    await this.save(task);
    await this.appendEvent(id, { type: "task.created", task: { goal: task.goal, cwd: task.cwd, primary, fallback } });
    return task;
  }

  async save(task) {
    return this.#enqueue(task.id, async () => {
      await fs.mkdir(this.taskDir(task.id), { recursive: true });
      task.updatedAt = nowIso();
      const target = this.statePath(task.id);
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(task, null, 2)}\n`, "utf8");
      await fs.rename(tmp, target);
      return task;
    });
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(this.statePath(id), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async require(id) {
    const task = await this.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  async appendEvent(id, event) {
    return this.#enqueue(id, async () => {
      await fs.mkdir(this.taskDir(id), { recursive: true });
      const entry = { at: nowIso(), ...event };
      await fs.appendFile(this.eventsPath(id), `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    });
  }

  async readEvents(id, { limit = 80, includeExternal = true } = {}) {
    const rows = [];
    for (const file of [this.eventsPath(id), ...(includeExternal ? [this.externalEventsPath(id)] : [])]) {
      try {
        const text = await fs.readFile(file, "utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try { rows.push(JSON.parse(line)); } catch { rows.push({ at: "", type: "malformed", raw: line }); }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    rows.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
    return rows.slice(-limit);
  }

  async writeContext(id, text) {
    await fs.writeFile(this.contextPath(id), String(text), "utf8");
  }

  async #enqueue(id, fn) {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.queues.set(id, current);
    try { return await current; }
    finally { if (this.queues.get(id) === current) this.queues.delete(id); }
  }
}
