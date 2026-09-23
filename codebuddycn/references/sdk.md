# CodeBuddy CN Agent SDK reference

Read this file when SDK installation, option mapping, output handling, backend selection, or SDK-specific troubleshooting matters.

Authoritative sources:

- [CodeBuddy Agent SDK overview](https://www.codebuddy.cn/docs/cli/sdk)
- [TypeScript SDK reference](https://www.codebuddy.cn/docs/cli/sdk-typescript)
- [Official npm package](https://www.npmjs.com/package/@tencent-ai/agent-sdk)

## Architecture

`@tencent-ai/agent-sdk` is the official programmatic interface. Its `query()` API starts and controls a CodeBuddy Code CLI process and yields typed async messages. It does not turn a CodeBuddy subscription into a generic REST API and does not eliminate the CLI dependency.

This skill pins the SDK version in `package.json` and `package-lock.json`. Install exactly that dependency from the skill directory:

```bash
npm ci --omit=dev
```

The installed CodeBuddy CN CLI remains the transport. The wrapper passes its resolved executable as `options.pathToCodebuddyCode`, which keeps the existing Chinese Site login and avoids opening the IDE.

## Wrapper backend policy

`scripts/codebuddycn-run.mjs` defaults to:

```bash
--backend sdk
```

The compatibility path is explicit:

```bash
--backend cli
```

There is deliberately no automatic SDK-to-CLI fallback. An SDK exception, timeout, quota error, or missing final result may occur after the request reached the model. Replaying the prompt through another transport could duplicate edits, side effects, or quota consumption.

`CODEBUDDYCN_SDK_MODULE` exists only as a test/integration override for the module specifier. Normal calls must leave it unset so the pinned official package is loaded.

## Option mapping

The wrapper maps its stable flags to SDK `query({ prompt, options })` as follows:

| Wrapper | SDK option |
|---|---|
| `--model` | `model` |
| `--cwd` | `cwd` |
| `--add-dir` | `additionalDirectories` |
| `--tools` | `tools` |
| `--allowed-tool` | `allowedTools` |
| `--disallowed-tool` | `disallowedTools` |
| `--permission-mode` | `permissionMode` |
| `--skip-permissions` | `allowDangerouslySkipPermissions` (wrapper mapping only; SDK 0.3.251 does not forward it to the CLI transport) |
| `--max-turns` | `maxTurns` |
| `--setting-sources` | `settingSources` |
| `--persistent` | `persistSession: true` |
| default one-shot | `persistSession: false` |
| `--continue` | `continue: true` |
| `--resume` | `resume` |
| `--fork-session` | `forkSession: true` |
| `--include-partial-messages` | `includePartialMessages: true` |
| `--json-schema-file` | `outputFormat: { type: "json_schema", schema }` |
| system prompt flags | `systemPrompt` |

`--tools none` or the default empty value maps to `tools: []`, which disables all built-in tools. `--tools default` leaves `tools` undefined and is never selected implicitly. JSON Schema mode adds only `StructuredOutput` when tools would otherwise be disabled.

Input files and piped stdin are tagged and prepended to the SDK prompt in memory. Credentials are never embedded in the prompt or command arguments.

## Account selection

Imported account selection happens before `query()` and remains process-local. The wrapper decrypts the selected record through the operating-system credential service and passes only the child environment via `options.env`:

- `CODEBUDDY_AUTH_TOKEN`
- `CODEBUDDY_INTERNET_ENVIRONMENT=internal`
- account headers when required by the imported record

It does not call the unstable SDK login/logout APIs and does not overwrite CodeBuddy's global login state. This preserves the existing `cbXX` aliases, real labels, round-robin bookkeeping, token refresh, and cross-account session mapping.

## Messages and result envelope

The SDK returns an async stream containing `system/init`, `assistant`, and `result` messages. For `--format json`, the wrapper collects those messages and emits one compact object:

- `backend`: `sdk`
- `via`: `codebuddy-agent-sdk-chinese-site`
- `account`: selected alias and actual display name, without credentials
- `model_requested` and `model_used`
- `session.id`, resume/fork metadata, and migration warning
- `response.text` and `response.structured_output`
- duration, token usage, permission denials, and SDK error metadata

For `--format stream-json`, each SDK message is serialized as one JSON line. For `--format text`, only the final response text is printed.

The wrapper normalizes common failures to `authentication_required`, `quota_exhausted`, `network_error`, `model_service_error`, `timeout`, `cancelled`, or `codebuddy_failed`. It records a failed account run but never chooses another account or backend automatically.

## Sessions and cross-account resume

The SDK officially supports `continue`, `resume`, `forkSession`, and session persistence. CodeBuddy's local session files are also partitioned by account UID, so changing only `options.env` is not enough for a reliable cross-account resume.

For a user-authorized account change, the wrapper first stages the selected session under the target UID, then calls SDK `query()` with `resume` and forced `forkSession: true`, and finally restores the source session ownership. See [cross-account-resume.md](cross-account-resume.md).

## Troubleshooting

| Symptom | Action |
|---|---|
| `sdk_not_available` | Run `npm ci --omit=dev` in the skill directory and verify `node_modules/@tencent-ai/agent-sdk/lib/index.js` exists. No request was sent before this error. |
| `sdk_startup_failed` or missing `dist/codebuddy-headless.js` | Verify the actual executable format and path. Preflight checks import/version/help, not a successful SDK handshake. For the observed native CLI incompatibility, see [headless-development.md](headless-development.md). Do not auto-switch backends. |
| SDK package import works but query fails during initialization | Check CLI/SDK compatibility and Chinese Site login. Keep the exact failed prompt from being replayed automatically. |
| Missing final result or timeout | First inspect the task's process, JSONL, file changes and tests. Do not replay an uncertain prompt. Once the prior process is confirmed stopped, continue already-authorized unfinished work with a state-aware prompt; unresolved external side effects or cross-account replay follow the account-resume rules. |
| Model unavailable | Report the actual rejection, then use an alternative within the user's model-routing authorization in `../SKILL.md`; ask only when no authorized choice is clear. Do not change accounts or replay an uncertain request automatically. |
| Tool permission denied | Keep answer-only calls tool-free. For authorized development, distinguish tool exposure, automatic approval and permission mode; inspect actual tool results rather than assuming the user refused. See [headless-development.md](headless-development.md). |

The SDK is marked Preview by CodeBuddy. Before changing its pinned version, run all mock tests, verify a side-effect-free import, inspect the published option types, and only then ask the user before any real quota-consuming smoke call.
