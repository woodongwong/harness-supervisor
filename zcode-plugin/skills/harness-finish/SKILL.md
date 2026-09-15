---
name: harness-finish
description: Finish a Harness Relay worktree task by reviewing and committing its changes, merging its branch, verifying the result, and optionally cleaning up. Use when the user requests completion or merge of a worktree task, not for routine handoff or progress questions.
---

# Harness Finish

Respond in the user's language. Follow the requested scope: merging does not imply pushing or deleting a worktree. A request to finish and merge authorizes the necessary task commit; a status question authorizes inspection only. Retain the source worktree and branch unless cleanup is requested. Use existing authorization without asking again.

## Identify the task and destination

Resolve the installed skill symlink to find the Harness Relay checkout (three directories above `skills/harness-finish`). Run its CLI by absolute path, preserving any configured `HARNESS_RELAY_HOME`. Use `task-list --repo <repo> --json` and `status --cwd <source-worktree> --json` to identify the exact task, registered branch, source path, and execution owner. Do not select the newest task when multiple tasks match; ask for the missing identity.

Find the target branch's checkout with `git worktree list --porcelain`. Use the user's target branch; if omitted, use an established project default, otherwise ask. Confirm source and target share the same Git common directory, are different paths, and each has its expected branch checked out. Never switch the user's main checkout to another branch just to make the command succeed.

Print one short line identifying task, source branch and destination before mutation. Check Git status in both paths, including untracked files, and unfinished merge/rebase/cherry-pick operations. Inspect the source diff and run the task's relevant tests. Commit only this task's intended changes using explicit paths, excluding secrets and local runtime artifacts. Do not stash or commit unrelated changes in the target directory.

## Coordinate the two workspaces

An agent remains attached to its native session directory even when a shell command uses another `cwd`. Finishing a task does not move that session. If currently executing in the source worktree, complete review, tests and the task commit there, then provide the exact task ID, source commit, target path and remaining merge steps for a session opened in the target directory. End the source turn normally. Do not recursively launch an interactive coding client inside a tool or poll while waiting for it to exit.

Perform the merge from the target-directory session with its normal Relay execution rights. Confirm the source task is idle with no pending transfer or outstanding tools. Then run `task-close <task-id>` from outside the source worktree to fence further Relay writes while retaining its files and branch. If this refuses an active task, do not edit state or remove locks; finish the source turn first. Other independent writers in the target must also stop before merging. Relay does not lock out manual editors or nonintegrated clients.

Closing archives the task; it does not mean the code has merged. If subsequent validation fails, report the retained archived task and Git state. There is currently no automatic task-reopen command; do not invent one.

## Merge and verify

For an authorized merge, prefer the deterministic `task-integrate` CLI after preparing the task commit and identifying the target. Supply `--target <target-worktree> --branch <target-branch> --source-commit <full-SHA> --target-commit <full-SHA> --verify-json <JSON argv array>`, plus `--cleanup` only when requested. Run from the target session and supply its current injected `--lease` if active. The command closes the idle source, checks pinned commits and clean directories, merges, runs verification and optionally cleans up; it never commits source changes or pushes. A refusal is not permission to bypass the guard. Records and validation output are saved under the task directory.

When executing as a background worker and the task already authorizes merging on completion, prepare and test a clean task-only commit, then use `task-plan-finish <task-id> --target <target-worktree> --branch <branch> --verify-json <JSON argv array> [--cleanup]`. Only that worker can register its plan. End normally; the worker attempts integration after the native process exits. If another session owns the target or evidence is incomplete, it records integration_blocked and preserves the worktree. Do not force-close the live source or make the user issue another command when a valid finish plan can handle the already authorized steps.

Recheck both Git states and the exact source commit after closing. If either checkout has unexpected changes or the source branch moved, resolve that discrepancy before merging. Review `git log <target>..<source>` and the diff, rather than relying on a prior agent's completion claim.

Use Git argument arrays when available, otherwise quote every path and ref. From the target checkout merge the verified source commit with `git merge --no-ff --no-edit <source-commit>`. Never use force flags, reset away user changes, or silently prefer all of ours/theirs. Resolve conflicts within the authorized task when the intended behavior is clear; ask a focused question when it is not. Preserve the worktree while conflicts remain. Finish the merge and run relevant validation on the integrated target before reporting success.

Record the source commit, resulting target commit and test results in the final response. If verification fails, retain the source and report the failure; a successful Git merge alone is not acceptance. Push only when the user requests it, checking the intended remote and branch first. Do not force-push as part of this workflow.

## Optional cleanup

Only after successful merge and validation, and when cleanup is authorized:

1. Reconfirm the task is closed and idle, source branch still points at the reviewed source commit, source worktree is clean, and `git merge-base --is-ancestor <source-commit> <target>` succeeds.
2. Inspect ignored files as well with `git status --short --ignored`. Preserve the worktree when it contains local artifacts the user has not authorized deleting; normal worktree removal can delete ignored files.
3. From outside that worktree run `git worktree remove <source-path>`, without force. Then delete only that task branch with `git branch -d <source-branch>`. If either command refuses, preserve the remaining artifacts and report why. Never delete the target branch or prune unrelated worktrees.

Retain Relay task history. Report separately whether merge, validation, push and cleanup happened; do not describe unrequested or blocked steps as completed. Background finish plans require existing user authorization; a process exit or this skill alone does not authorize merging or deleting.
