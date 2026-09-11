import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessSupervisor } from "../src/supervisor.mjs";
import { TaskStore } from "../src/store.mjs";

class FakeAdapter {
  constructor(name, results) {
    this.name = name;
    this.results = [...results];
    this.prompts = [];
  }

  capabilities() {
    return { harness: this.name, headless: true, resumeSession: this.name === "codex" };
  }

  async run({ prompt, onEvent }) {
    this.prompts.push(prompt);
    await onEvent({
      type: "worker.native",
      harness: this.name,
      payload: this.name === "codex"
        ? { type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 1 } }
        : { type: "stdout", text: "continuing" },
    });
    return this.results.shift();
  }
}

test("quota failure hands the same task to the other native harness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hs-store-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hs-repo-"));
  const codex = new FakeAdapter("codex", [
    { exitCode: 1, signal: null, sessionId: "c1", output: "", stderr: "usage limit", reason: "quota" },
  ]);
  const zcode = new FakeAdapter("zcode", [
    { exitCode: 0, signal: null, sessionId: "z1", output: "done", stderr: "", reason: null },
  ]);
  const supervisor = new HarnessSupervisor({
    store: new TaskStore(root),
    adapters: { codex, zcode },
  });

  const { task } = await supervisor.runNew({ cwd, goal: "fix auth", primary: "codex", fallback: "zcode" });
  assert.equal(task.status, "completed");
  assert.equal(task.sessions.codex, "c1");
  assert.equal(task.sessions.zcode, "z1");
  assert.equal(task.attempts.length, 2);
  assert.match(zcode.prompts[0], /taking over an existing coding task/i);
  assert.match(zcode.prompts[0], /usage limit|quota/i);

  const events = await supervisor.store.readEvents(task.id, { limit: 100 });
  assert.ok(events.some((event) => event.type === "worker.failover" && event.from === "codex" && event.to === "zcode"));
});
