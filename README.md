# Harness Supervisor

Harness Supervisor keeps **Codex and ZCode as native harnesses**. It does not route both models through one generic agent loop. The shared layer owns only durable task state, an append-only journal, workspace/Git state, and takeover context.

## Goal

The main failure case is simple: Codex is working under a subscription, then its quota is exhausted before it can summarize. The supervisor preserves the observable task state so the same task can be handed to ZCode without asking Codex for a final response. The inverse direction (ZCode → Codex) is also supported at the state/handoff layer.

## Current integration status

### Codex

Codex is the deep integration path:

- launches `codex exec --json`
- records every structured JSONL event
- stores `thread.started.thread_id`
- can resume the native thread later
- detects quota/auth/transport/process failures from native errors/stderr

### ZCode

ZCode is treated as a closed-source harness. The **officially supported integration path today is its plugin/hook API**:

- the included ZCode Hook plugin records `SessionStart`, prompt, tool, permission, tool failure, and `Stop` events
- each hook invocation snapshots ZCode's temporary `transcript_path` into durable task storage
- `SessionStart` can inject the supervisor's `context.md` into a new ZCode session
- native/headless launch and resume are **not assumed**

ZCode's public documentation currently describes the desktop application and Hook/plugin interfaces, but not a stable `zcode --prompt` headless CLI contract. Therefore automatic ZCode process launching is only enabled when you explicitly configure a launcher via `ZCODE_SUPERVISOR_ARGS_JSON`; do not rely on the built-in placeholder default as an official ZCode interface.

## Requirements

- Node.js 20+
- Codex CLI installed and authenticated for Codex execution
- ZCode installed and authenticated for ZCode execution

## Check the repository

```bash
npm test
npm run check
node src/cli.mjs capabilities
```

## Run Codex as the primary worker

```bash
node src/cli.mjs run \
  --cwd /path/to/repo \
  --task "Fix the refresh-token race and run affected tests" \
  --primary codex \
  --fallback none
```

Persistent state defaults to `~/.harness-supervisor/tasks/<task-id>/`:

```text
task.json
events.jsonl
external-events.jsonl
context.md
native/zcode-*.jsonl
```

## Install the ZCode bridge plugin

The repository includes a root `marketplace.json`, so ZCode can load the bridge as a custom marketplace.

1. In ZCode open **Settings -> Plugins**.
2. Click **Create -> Add marketplace**.
3. Add this repository (or a local checkout of it).
4. In the Personal marketplace, install and enable `harness-supervisor-bridge`.
5. Start a **new ZCode session** after enabling the plugin; hook configuration is snapshotted at session startup.

The plugin uses ZCode's documented Hook protocol; it does not patch or reverse-engineer the ZCode process.

## ZCode launcher configuration

If you have a real ZCode launcher/runtime that accepts a prompt non-interactively, configure it explicitly:

```bash
export ZCODE_BIN=/path/to/your/zcode-launcher
export ZCODE_SUPERVISOR_ARGS_JSON='["--prompt","{prompt}"]'
```

Supported placeholders: `{prompt}`, `{session}`, `{cwd}`, `{task}`.

If that launcher also supports resume, configure it explicitly, for example:

```bash
export ZCODE_SUPERVISOR_RESUME_ARGS_JSON='["resume","{session}","--prompt","{prompt}"]'
```

Only after a working launcher is configured should you use automatic Codex -> ZCode failover:

```bash
node src/cli.mjs run \
  --cwd /path/to/repo \
  --task "Fix the refresh-token race and run affected tests" \
  --primary codex \
  --fallback zcode
```

## Codex configuration

`CODEX_BIN` defaults to `codex`. Extra global `codex exec` arguments can be supplied as JSON:

```bash
export CODEX_SUPERVISOR_ARGS_JSON='["--sandbox","workspace-write"]'
```

The supervisor deliberately does not force `--dangerously-bypass-approvals-and-sandbox`.

## Manual takeover

The state layer supports explicit takeover:

```bash
node src/cli.mjs takeover task-... \
  --to codex \
  --feedback "ZCode quota is exhausted; continue from the current diff"
```

A ZCode takeover still needs a configured non-interactive ZCode launcher in the current MVP. Without that launcher, use the bridge plugin to observe/persist ZCode sessions, but start the ZCode session manually in the desktop client.

## Failure semantics

Automatic failover occurs for `quota`, `auth`, `transport`, and generic process failures. The takeover context is built from the original goal, recent durable Codex/ZCode journal events, current Git status, and staged/unstaged diffs.

Unobservable model-internal reasoning cannot be recovered; observable work is made durable as it happens.

## Tests

```bash
npm test
npm run check
```

The tests use fake child processes and do not consume Codex or ZCode quota. They are unit/integration-style tests for the supervisor logic, not a real subscription/quota end-to-end test against live Codex and ZCode accounts.
