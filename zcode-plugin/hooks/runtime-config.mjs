import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A shared resolver keeps CLI and copied ZCode plugins on the same task store.
// Existing stores retain their paths, including Git worktree registrations.
export function relayHome({ env = process.env, home = os.homedir(), exists = existsSync } = {}) {
  if (env.HARNESS_RELAY_HOME) return env.HARNESS_RELAY_HOME;
  if (env.HARNESS_SUPERVISOR_HOME) return env.HARNESS_SUPERVISOR_HOME;
  const legacy = path.join(home, ".harness-supervisor");
  return exists(legacy) ? legacy : path.join(home, ".harness-relay");
}

export function relayEnv(suffix, env = process.env) {
  return env[`HARNESS_RELAY_${suffix}`] ?? env[`HARNESS_SUPERVISOR_${suffix}`];
}
