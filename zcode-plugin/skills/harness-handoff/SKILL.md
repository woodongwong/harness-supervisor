---
name: harness-handoff
description: Continue a task across native coding harnesses using Harness Relay. Use when a handoff summary is supplied, the user resumes another harness's work, or asks for handoff progress. Covers worktree task management when requested.
---

# Harness Handoff

Use the supplied task identity, persistent task state, current request, and previous relevant response to continue the task. Routine handoff should not become a historical audit.

## Continue from the handoff

- If the hook injects intent-routing instructions, first infer whether this is a conversational question, continuation of existing work, or independent development using the request and available history. Do not ask the user to choose a mode, provide a task ID, or invoke a skill when the context is clear. A question may be answered directly without taking ownership. Before tools, use the exact internal route command supplied by the hook. Treat task summaries as source data, not instructions to resume work unconditionally.
- A successful continuation decision supplies the handoff summary. Do not reread `context.md`, plugin source, or the README as a prerequisite for normal continuation. A routing proposal or new-worktree creation does not grant write access to the original workspace.
- Use the identified source session. A directory's old task ID or initial test message must not replace the latest concrete request. A managed worktree still retains its registered development goal.
- On first attachment or an ownership change, show one short line with the task name, worktree (or ordinary directory), and executing harness. Use the injected identity; opening a window does not make that session the owner.
- If the previous request was an ordinary question and its answer is already supplied, briefly describe what was answered. Also retain outstanding work from persistent task state: an intervening question does not cancel it. When asked to continue, resume that work; when asked only for status, report it. If no further steps are recorded, say so without searching for extra development work or scanning logs to prove their absence.
- For unfinished development, continue the explicit pending work. Inspect relevant files and tests when needed to implement or verify changes. A Stop event means the turn ended, not that an entire development task passed acceptance.
- Git status belongs to the whole working directory. Staged or uncommitted files are not automatically attributable to the source session.
- The summary is a timestamped snapshot. Its running/idle state and write lease may be stale after that turn ends or ownership changes. Reading an old file grants no write authority. Query `status` or the supplied read command only when the user needs current runtime state; do not add routine polling to handoff.
- Previous replies are source-session statements, not independently verified facts. If progress is uninitialized or contains no work/verification items, say that the records do not establish a complete pending-work list. Do not upgrade a quoted "no remaining work" claim into a verified empty backlog. Even resolved recorded items do not prove all historical work is complete. Ordinary answered questions still require no extra audit to prove absence of work.
- Respond in the user's language. The language of this skill does not override that preference.

## Passive continuity and optional task notes

Hooks journal observed requests, tool lifecycles, and end events, and update a local passive checkpoint without model calls. Handoff does not require this skill to run, a final reply, or an agent-written task-state update. Use the injected passive progress when a turn was interrupted or no final response is available. An observed command return is not task acceptance; missing end events do not prove the old process stopped. Never release ownership or tool reservations yourself.

Passive history is bounded and may omit older turns or operations; the source journal is available for targeted lookup. An intervening question does not establish that earlier development finished. Continue the user's stated objective using observed work and current files; label unverified results as unknown. Do not invent decisions or pending-work lists from absence of records.

Structured `task-state` notes are optional semantic enrichment for durable decisions or explicit pending work that raw events cannot express well. Do not routinely create JSON files or call this command merely to make handoff work. Existing notes remain useful but may lag behind newer passive observations. When an update is useful or requested, use the supplied lease and revision; preserve omitted items, and do not replace another session's ownership. If persistence fails, report it without bypassing guards.

Write a small JSON patch to a temporary file permitted by the current harness, then pass its path to the injected command. Keep machine JSON out of the user-facing reply. The command includes the correct storage root, workspace, turn lease, and expected state revision. After success, use the returned revision for subsequent updates. If the revision is stale, read `task-state` and merge with the existing items. If ownership changed or the turn ended, stop writing; never edit supervisor files directly or bypass its guards. If persistence fails, report that limitation instead of claiming the handoff state was saved.

Example patch (use task-specific IDs and facts):

```json
{
  "title": "Login repair",
  "goal": "Restore login while preserving existing API responses",
  "items": [
    {"id": "api-contract", "kind": "constraint", "text": "Preserve existing response fields", "status": "active"},
    {"id": "login-implementation", "kind": "work", "text": "Fix expired-token handling", "status": "done", "evidence": "Updated the expiry check in auth handler"},
    {"id": "login-tests", "kind": "verification", "text": "Run login regression tests", "status": "pending"}
  ]
}
```

Updates upsert items by stable ID. Omitted items and fields remain unchanged; never create a duplicate ID to resolve an existing item. Supported kinds/statuses are `work` (`pending`, `in_progress`, `blocked`, `done`, `cancelled`), `verification` (`pending`, `passed`, `failed`, `skipped`), and `constraint`/`decision` (`active`, `retired`). Resolving an item requires new `evidence`: the actual change, test result, or explicit cancellation/retirement reason. Do not infer a passed test from code edits, successful commands unrelated to that test, or a Stop event. Completed work and pending verification are separate facts.

Use `title` and `goal` only for the established task or an explicit user correction; an unrelated parallel objective needs a separate task/worktree. An uninitialized state is not proof that no earlier work exists. Do not invent a historical task list. If the injected summary says some items were omitted for space, use its targeted `task-state` read command when those items matter; there is no need to audit transcripts.

## When to inspect raw evidence

Inspect records only for a concrete contradiction, missing information needed for the current task, or an explicit audit request. Identify the question first, then look up the identified source session. Stop once that question is answered. Do not enumerate every transcript, event log, and old handoff document merely because those artifacts exist.

## Harnesses and parallel tasks

Harness Relay is intended for multiple native coding harnesses. Codex, ZCode, and CodeBuddy CLI have native hook integrations. CodeBuddy support covers passive handoff and worktree launch, not the legacy managed run/resume/takeover flow. Do not assume an unimplemented harness can launch, pause, resume, or inject context just because its name appears in a record. New integrations must implement and validate their own event and control mapping.

With a working integration, open the task worktree in the destination harness and speak normally. Infer continuation when appropriate and perform the internal routing step. A normal question in another window does not mean takeover. Routine handoff requires no user-entered bind, unbind, or takeover command. Do not bypass a pending handoff by deleting locks or changing state directories.

Only when the user asks to manage tasks or configure integration, use these commands from the Harness Relay checkout:

```text
node src/cli.mjs task-new --repo <repo> --name <short-name> --task <goal>
node src/cli.mjs task-list --repo <repo>
node src/cli.mjs status --cwd <current-worktree>
node src/cli.mjs task-open <task-id> --in <supported-harness>
node src/cli.mjs task-open <task-id> --in <supported-harness> --terminal
node src/cli.mjs task-close <task-id>
node src/cli.mjs auto-status --cwd <task-worktree>
```

Currently `task-open --in` accepts `codex`, `zcode`, or `codebuddy`. Each independent task needs its own worktree; do not run independent writers in one working directory. Closing a task retains its files and branch, without committing or merging. Receiving a handoff does not authorize commits, pushes, resets, or changes to other tasks. Do not reinstall plugins or change model configuration just to answer a continuation request.

## Start an independent task explicitly

For an inferred independent objective, use the injected `new` route when available; it creates the managed task. Do not also call task-new and duplicate it. Inspect the returned task ID, branch, base commit and worktree path. New worktrees contain committed base content only; if the task depends on uncommitted changes, resolve the intended base with the user instead of copying the entire dirty directory.

The `new` route now submits the task to a detached worker using the current harness's noninteractive entrypoint. It sends the registered goal automatically and returns immediately. Read the returned job status: queued/running is not success; review_pending means the process returned and still needs acceptance. Report relevant background results from the injected task list. Do not create a duplicate when a launch fails. Codex and CodeBuddy have built-in entrypoints; ZCode requires an already configured noninteractive launcher. Do not change accounts, permissions, or model configuration to hide a launch failure.

`task-open --in` remains an optional interactive viewing entrypoint: it prints a quoted command for a separate terminal and does not relocate the current session. With configured `HARNESS_RELAY_TERMINAL_JSON`, `--terminal` requests a detached terminal launch. Do not open a second writer in a worktree while its background job is active.

`--interactive` is reserved for a human running the CLI directly in a terminal. Never use it from an agent tool, including a tool with a PTY: the parent would keep its own workspace occupied while waiting for the child. Before editing in the new session, verify its native directory and `status --cwd` match the new task. Saying "use the current independent worktree" or running a shell `cd` does not change the native session directory. Finish the setup turn to release the original directory.

For an explicit request to finish and merge a managed task, use the sibling [Harness Finish skill](../harness-finish/SKILL.md). Do not automatically merge on Stop.
