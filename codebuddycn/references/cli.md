# CodeBuddy CN CLI transport and fallback reference

Read this file when the SDK's underlying CLI installation, Chinese Site authentication, account environment, explicit CLI fallback, or CLI troubleshooting matters. SDK-specific behavior is documented in [sdk.md](sdk.md). The authoritative documentation is:

- [Quick Start](https://www.codebuddy.cn/docs/cli/quickstart)
- [CLI Reference](https://www.codebuddy.cn/docs/cli/cli-reference)
- [Headless Mode](https://www.codebuddy.cn/docs/cli/headless)
- [Environment Variables](https://www.codebuddy.cn/docs/cli/env-vars)

## Install and authenticate

CodeBuddy 中国站的独立 CLI 与 CodeBuddy CN IDE 的 `buddycn` 启动器不同。独立 CLI 在所有站点都叫 `codebuddy`（别名 `cbc`），中国站由登录选项或 API 环境变量决定。官方安装方式包括：

```bash
# macOS / Linux native installer (preferred for the China-site CLI)
curl -fsSL https://copilot.tencent.com/cli/install.sh | bash

# npm alternative; requires Node.js 18.20 or newer
npm install -g @tencent-ai/codebuddy-code
```

On Windows, the official native command is:

```powershell
irm https://copilot.tencent.com/cli/install.ps1 | iex
```

Install only within the user's authorization; an explicit request to install this skill can cover its SDK dependency, so do not ask again for that same scope. After installation, verify with `codebuddy --version`, then run `codebuddy` interactively, enter `/login`, and let the user choose **Log in via Chinese Site**. Authentication may require a browser, so do not attempt to automate credential entry or read its stored tokens.

`CODEBUDDY_API_KEY` is supported, but it is not the default for this skill. For a China-site API key, also set `CODEBUDDY_INTERNET_ENVIRONMENT=internal`. Never print credential values; preflight reports only their presence.

## Explicitly authorized multi-account store

When the user has explicitly authorized local credential handling and supplied a Cockpit/WorkBuddy JSON export, import it with:

```bash
node "{baseDir}/scripts/codebuddycn-accounts.mjs" import-cockpit /absolute/export.json
```

The importer accepts the exported account array, validates required token fields, deduplicates identities, tightens the source file to mode `0600` on POSIX, and creates stable aliases such as `cb01`. Secret payloads go to:

- macOS: a generic-password item in Keychain, written through a tiny Security Framework helper whose stdin carries the secret.
- Windows: a per-user DPAPI blob (`CurrentUser`) in the private account directory.
- Linux: the current desktop Secret Service through `secret-tool`.

There is deliberately no plaintext fallback. The metadata index contains aliases, the export's actual account nickname, selection cursor, timestamps, and success/failure counters. A nickname may itself be a full phone number or email address, so treat the index and account-list output as private. The index is stored in the platform application-data directory with restrictive permissions. `CODEBUDDYCN_ACCOUNT_HOME` may override that directory for testing.

Use `list` to inspect account names and `verify ALIAS` to validate/decrypt one credential locally. Use `sync-labels EXPORT.json` to update names from an export without rewriting system credentials. `remove ALIAS --yes` deletes both the system credential and its metadata. Never print or return the environment object produced internally by the account module.

The wrapper accepts `--account ALIAS` or `--account auto`. Selection is process-local: it gives only the spawned CodeBuddy process `CODEBUDDY_AUTH_TOKEN`, `CODEBUDDY_INTERNET_ENVIRONMENT=internal`, and the account headers expected by the official CLI. It does not edit CodeBuddy's global auth file. Expiring OAuth tokens are refreshed against the CodeBuddy CN token-refresh endpoint and immediately written back to the same system credential item.

`auto` is deterministic round-robin selection, not quota-error failover. One invocation selects one account and never retries the model request under a second identity. This is important for prompts that may perform actions or incur usage. Do not combine `auto` with `--continue` or `--resume`; select an explicit alias for a continuing session.

## Direct headless calls and explicit fallback

Core syntax:

```bash
codebuddy -p "question" --output-format text
codebuddy -p "question" --output-format json
codebuddy -p "question" --output-format stream-json
cat context.txt | codebuddy -p "analyze only this input" --output-format json
codebuddy --model MODEL_ID -p "question"
```

These commands run entirely in the terminal and return the answer on stdout. Do not invoke `buddycn chat` and do not use GUI automation.

The wrapper in `scripts/codebuddycn-run.mjs` uses the official Agent SDK by default. The SDK itself starts a CLI transport and yields messages. Direct public CLI flags are retained only behind explicit `--backend cli` for compatibility and diagnostics:

```bash
node "{baseDir}/scripts/codebuddycn-run.mjs" \
  --backend cli \
  --account cb01 \
  --model MODEL_ID \
  --prompt "question" \
  --format json
```

For `--format json`, both backends return the same stable envelope containing only the final answer, structured output (when present), and execution metadata. The CLI fallback collects CodeBuddy JSONL internally to avoid exposing the full injected prompt/transcript and to work around native releases that can truncate a large single JSON document.

Output behavior:

- `text`: final answer as plain text.
- `json`: one wrapper JSON value. Read the final answer from `response.text`; schema output, when present, is under `response.structured_output`.
- `stream-json`: JSONL events, including initialization, messages, tool events, and a final result. The SDK backend serializes each SDK message; the CLI backend forwards native JSONL.

## Models

Available models depend on account, region, plan, organization policy, and current product configuration. Follow the current user's explicit model choice or a routing rule they have already authorized locally. This shared skill contains no personal routing preference or price list. Omit the model only when the user chooses the current default. CLI help and SDK enumeration can lag behind the live model selector. A missing entry alone does not prove unavailability.

The wrapper maps `--model MODEL_ID` to SDK `options.model`; the explicit CLI backend passes the same CLI flag. An invalid or unavailable ID should be reported as-is rather than silently replaced.

Model selection and account selection are independent. For example:

```bash
node "{baseDir}/scripts/codebuddycn-run.mjs" \
  --account cb03 \
  --model MODEL_ID \
  --prompt "question" \
  --format json
```

## Tool and permission boundary

The SDK's one-shot query transport is non-interactive. Tool operations requiring approval can be blocked unless permissions are explicitly configured. Broad bypass must not be the wrapper default.

For answer-only use:

```bash
codebuddy -p "question" --tools "" --output-format json
```

CodeBuddy implements `--json-schema` through its built-in `StructuredOutput` tool. When a schema file is supplied, the wrapper automatically enables only that non-mutating tool if tools would otherwise be disabled; it does not grant file, shell, network, or project access.

For authorized agentic work, combine the smallest practical tool whitelist with a scoped working directory. On the default backend the wrapper maps:

- `--tools "Read,Glob,Grep"` → SDK `tools`
- repeated `--allowed-tool VALUE` → SDK `allowedTools`
- repeated `--disallowed-tool VALUE` → SDK `disallowedTools`
- `--skip-permissions` → SDK `allowDangerouslySkipPermissions` (wrapper mapping only; SDK 0.3.251 does not forward it to the CLI)
- `--permission-mode MODE` → SDK `permissionMode`

The explicit CLI backend translates those same wrapper flags to the corresponding CLI flags.

Never set `CODEBUDDY_IS_SANDBOX=1` merely because the caller is an agent. It is appropriate only when the CodeBuddy process itself is inside a genuine disposable/isolated sandbox and the user authorized full bypass.

## Sessions and settings

The wrapper uses SDK `persistSession: false` by default for one-shot calls and `settingSources: ['user']`, avoiding project/local CodeBuddy settings unless requested. Use `--persistent` to keep a new conversation, `--continue` for the most recent conversation, or `--resume SESSION_ID` for a known session. Continue and resume are mutually exclusive. JSON output includes the active ID at `session.id` when CodeBuddy emits one. The CLI fallback maps these to the equivalent public flags.

For an explicitly requested cross-account resume, read [cross-account-resume.md](cross-account-resume.md). This is a local session migration plus a fork, not a plain token swap: use a fixed source alias, fixed target alias, `--resume-from-account`, and JSON output. It temporarily mutates local CodeBuddy session storage and must not run concurrently with CodeBuddy CN IDE writing the same data.

Use `--setting-sources user,project,local` only when project-provided CodeBuddy configuration is intentionally in scope. Treat repository settings, skills, hooks, and MCP definitions as code that may change behavior or cause external access.

## Troubleshooting

| Symptom | Action |
|---|---|
| `sdk_not_available` | Reinstall the pinned dependency with `npm ci --omit=dev` in the skill directory; use `--backend cli` only by explicit choice. |
| `codebuddy` not found but CodeBuddy CN IDE is installed | Install the separate CodeBuddy Code CLI; the IDE's `buddycn` command is unrelated to headless output. |
| `authentication_required` or `Please use /login` | Run `codebuddy` interactively, enter `/login`, and choose **Chinese Site**. |
| `no_accounts` or `account_not_found` | Import an authorized export, run the account `list` command, and use one of its aliases. |
| `credential_not_found` | The metadata exists but the OS credential item is absent; re-import the authorized source export. |
| `token_refresh_failed` | Check connectivity to CodeBuddy CN and whether the refresh token remains valid; re-export/re-import or log in again if it was revoked. |
| China API key is rejected or routed incorrectly | Set `CODEBUDDY_INTERNET_ENVIRONMENT=internal`; do not set this merely for an existing OAuth login unless the official flow requires it. |
| Model rejected | Verify the actual model ID against the user's current selector or rejection. Follow the current user's authorized model choice; omit `--model` only when the user chooses the account default. A stale list is not a rejection. |
| Tool call blocked in print mode | Prefer explicit context for answer-only tasks. For authorized actions, configure tool exposure and automatic approval separately; SDK 0.3.251 does not forward the wrapper's skip flag. See [headless-development.md](headless-development.md). |
| A first headless call hangs or times out | Run `codebuddy` interactively to finish login/account selection; if already logged in, verify configured HTTP(S) proxy reachability. |
| JSON consumer fails on streaming output | Parse one object per line; `stream-json` is JSONL, not one JSON document. |
| Project behavior differs unexpectedly | Keep the default user-only setting source, inspect project `.codebuddy` configuration, and do not load it implicitly. |
