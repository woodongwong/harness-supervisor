# Harness Supervisor

Harness Supervisor keeps **Codex and ZCode as native harnesses**. It does not route both models through one generic agent loop. The shared layer owns only durable task state, an append-only journal, workspace/Git state, and takeover context.

## Goal

The main failure case is simple: Codex is working under a subscription, then its quota is exhausted before it can summarize. The supervisor hands the same task to ZCode without asking Codex for a final response. The inverse direction (ZCode → Codex) is also supported.

## Architecture

```text
                     Supervisor
           task.json / events.jsonl / context.md
                         |
              +----------+----------+
              |                     |
        CodexAdapter             ZCodeAdapter
              |                     |
       codex exec --json       ZCode native runtime
       native thread id        + bridge plugin hooks
              |                     |
              +------ same Git workspace ------+
```

### Codex integration

Codex is the deep integration path:

- launches `codex exec --json`
- records every structured JSONL event
- stores `thread.started.thread_id`
- can resume the native thread later
- detects quota/auth/transport/process failures from native errors/stderr

No final summary is required for failover.

### ZCode integration

ZCode is treated as a closed-source harness with capability negotiation:

- launcher command is configurable; default: `zcode --prompt "..."`
- included ZCode Hook plugin records `SessionStart`, prompt, tool, permission, tool failure, and `Stop` events
- each hook invocation snapshots ZCode's temporary `transcript_path` into durable task storage
- `SessionStart` injects the supervisor's `context.md` into a new ZCode session
- native resume is **not assumed**; if a launcher exposes it, configure `ZCODE_SUPERVISOR_RESUME_ARGS_JSON`

## Run

Requires Node.js 20+.

```bash
node src/cli.mjs capabilities
node src/cli.mjs run \
  --cwd /path/to/repo \
  --task "Fix the refresh-token race and run affected tests" \
  --primary codex \
  --fallback zcode
```

Persistent state defaults to `~/.harness-supervisor/tasks/<task-id>/`:

```text
task.json
events.jsonl
external-events.jsonl
context.md
native/zcode-*.jsonl
```

Manual takeover:

```bash
node src/cli.mjs takeover task-... \
  --to codex \
  --feedback "ZCode quota is exhausted; continue from the current diff"
```

## ZCode bridge plugin

Install `zcode-plugin/` as a local ZCode plugin and enable it. The plugin uses ZCode's Hook protocol; it does not patch or reverse-engineer the ZCode process.

When the supervisor launches ZCode it exports:

```text
HARNESS_SUPERVISOR_TASK_ID
HARNESS_SUPERVISOR_TASK_DIR
HARNESS_SUPERVISOR_CONTEXT_FILE
HARNESS_SUPERVISOR_EVENT_SINK
```

Without those variables the plugin writes to `ZCODE_PLUGIN_DATA/native-harness-events.jsonl` instead.

## ZCode launcher configuration

Default:

```text
ZCODE_BIN=zcode
ZCODE_SUPERVISOR_ARGS_JSON=["--prompt","{prompt}"]
```

Supported placeholders: `{prompt}`, `{session}`, `{cwd}`, `{task}`.

If a specific ZCode runtime exposes resume, opt in explicitly, for example:

```bash
export ZCODE_SUPERVISOR_RESUME_ARGS_JSON='["resume","{session}","--prompt","{prompt}"]'
```

The supervisor only advertises `resumeSession: true` after this is configured.

## Codex configuration

`CODEX_BIN` defaults to `codex`. Extra global `codex exec` arguments can be supplied as JSON:

```bash
export CODEX_SUPERVISOR_ARGS_JSON='["--sandbox","workspace-write"]'
```

The supervisor deliberately does not force `--dangerously-bypass-approvals-and-sandbox`.

## Failure semantics

Automatic failover occurs for `quota`, `auth`, `transport`, and generic process failures. The takeover prompt is built from the original goal, recent durable Codex/ZCode journal events, current Git status, and staged/unstaged diffs.

Unobservable model-internal reasoning cannot be recovered; observable work is made durable as it happens.

## Tests

```bash
npm test
npm run check
```

The tests use fake child processes and do not consume Codex or ZCode quota.
