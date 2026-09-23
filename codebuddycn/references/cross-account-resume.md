# CodeBuddy CN cross-account resume

Read this reference only when the user wants to continue a persisted CodeBuddy conversation under a different imported account.

## What the mechanism does

CodeBuddy local conversations are partitioned by account UID. A session body lives below the account-specific `CodeBuddyExtension/Data` tree, while `codebuddy-sessions.vscdb` records the session's `userId`. Supplying another account token alone is therefore not a reliable cross-account resume.

The implementation follows the local-session-sharing mechanism used by [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools) (reviewed at commit `1e2af3df5f4ecb047571974c278a86af62396e52`): it stages the selected conversation body and auxiliary restore state under the target UID and temporarily remaps that conversation's database row. Unlike Cockpit's whole-account merge, this skill scopes the operation to one requested session.

The wrapper then invokes the official Agent SDK with `resume` and `forkSession: true` (or the CLI only when `--backend cli` was explicitly selected). After the process exits, the wrapper restores the parent session's original database ownership and removes only the staged parent copy. Any distinct fork created for the target account is preserved. Existing target conversations and unrelated database rows are not replaced.

The operation reads and writes local session data only. It does not upload session files. The actual model request still contacts CodeBuddy CN normally and consumes the selected target account's quota.

## Required information

Collect all four values before calling the model:

1. Source account alias (`cbXX`).
2. Target account alias (`cbXX`), different from the source.
3. Persisted session ID: `session.id` from JSON, or `session_id` from the source call's init/result JSONL events.
4. Target model ID selected by the current user's explicit choice or their locally authorized routing rule described in `../SKILL.md`; omit it only for the user's explicit choice of “current default model.”

If the user gives an actual account name, resolve it through the account list. If a name is duplicated, ask for the alias. Never choose the source or target with `auto`.

## Starting a resumable conversation

Use `--persistent` from the first call. JSON provides a compact result; `stream-json` can be used for long-running development if its init/result session ID is recorded:

```bash
node "{baseDir}/scripts/codebuddycn-run.mjs" \
  --account cb01 \
  --model MODEL_ID \
  --persistent \
  --format json \
  --prompt "Start the task"
```

Record the selected account alias and returned session ID. A one-shot call made with the default `--no-session-persistence` cannot later be resumed. The actual cross-account transfer still requires `--format json`, regardless of the source call's output format.

## Switching accounts

Ask the user to close CodeBuddy CN IDE and avoid another CodeBuddy process writing the same session while the transfer is running. Then invoke:

```bash
node "{baseDir}/scripts/codebuddycn-run.mjs" \
  --account cb02 \
  --model MODEL_ID \
  --resume SESSION_ID \
  --resume-from-account cb01 \
  --format json \
  --prompt "Continue from the existing context"
```

`--resume-from-account` automatically enables SDK `forkSession: true`; do not disable it. On success, update the remembered active session to the returned `session.id` and its account to `account.alias`. A later switch uses that new pair as its source.

Prefer switching immediately after a confirmed successful turn. If quota exhaustion or a transport failure interrupted a turn, the last prompt may already have reached the model or executed tools. Do not submit it again under the target account unless the user explicitly confirms that retry.

The wrapper retains up to five operation backups below the platform-private `codebuddycn-skill/session-backups` directory. It also serializes transfers with a local lock, validates UID/session path components, rejects symlinks, and uses atomic directory/index replacement.

## Failure rules

- Never switch accounts or backends by replaying a failed prompt automatically. The request may have reached the model or performed tools even if the SDK/CLI returned an error.
- If `session.warning` is non-null, report it and stop. In particular, a missing/distinct fork ID is an uncertain persistence outcome, not permission to retry.
- `session_not_found_for_source` means the supplied session does not live under the claimed source account. Re-check the last successful `account.alias` and `session.id`.
- `account_uid_missing` means the imported credential lacks the UID needed to address local storage. Re-import from an authorized Cockpit/WorkBuddy export containing UID data.
- `session_restore_failed` means staged data was not fully restored. Do not run another migration until the retained `backup_dir` has been inspected or restored.
- Account-specific MCP servers, repositories, permissions, model availability, and organization resources do not migrate with the transcript. Explain any resulting tool/resource failure rather than treating it as lost conversation context.

This feature is local-storage compatibility behavior, not an official server-side transfer guarantee. Re-check the local CodeBuddy data layout after major CodeBuddy or Cockpit schema changes before relying on it.
