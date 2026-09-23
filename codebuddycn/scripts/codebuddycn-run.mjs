#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  getAccountSessionIdentity,
  prepareAccountRuntime,
  recordAccountRun,
} from "./codebuddycn-accounts.mjs";
import {
  restoreTransferredSession,
  transferSessionForAccount,
  validateSessionId,
} from "./codebuddycn-session-transfer.mjs";

const WIN = process.platform === "win32";
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function usage() {
  return [
    "Usage:",
    '  codebuddycn-run.mjs --prompt "<question>" [options]',
    '  codebuddycn-run.mjs "<question>" [options]',
    "",
    "Safe defaults:",
    '  --backend sdk --tools "" --agent cli --max-turns 1 --setting-sources user',
    "  JSON Schema calls enable only CodeBuddy's non-mutating StructuredOutput tool",
    "  Session persistence disabled (unless --persistent/--continue/--resume)",
    "  SDK failures never replay through the CLI backend automatically",
    "",
    "Input:",
    "  --prompt <text>                 Prompt text",
    "  --prompt-file <path>            Read prompt from a UTF-8 text file",
    "  --input-file <path>             Pipe a selected UTF-8 context file (repeatable)",
    "",
    "Model/output:",
    "  --backend sdk|cli             Default: sdk; cli is an explicit fallback",
    "  --account <alias|auto>          Use a stored account for this process only",
    "  --model <id>                    Request an account-available model",
    "  --format text|json|stream-json  Default: json",
    "  --json-schema-file <path>       Validate structured output (json only)",
    "  --max-turns <n>                 Default: 1",
    "  --timeout <seconds>             Default: 600",
    "",
    "Scope and behavior:",
    "  --cwd <dir>                     Child working directory",
    "  --agent <id>                    Default: cli",
    '  --tools <csv|default|none>       Default: none (maps to --tools "")',
    "  --add-dir <dir>                 Additional directory (repeatable)",
    "  --allowed-tool <spec>           CodeBuddy --allowedTools value (repeatable)",
    "  --disallowed-tool <spec>        CodeBuddy --disallowedTools value (repeatable)",
    "  --permission-mode <mode>        default|acceptEdits|auto|dontAsk|plan|bypassPermissions",
    "  --skip-permissions              Pass --dangerously-skip-permissions (high risk)",
    "  --setting-sources <csv>         Default: user",
    "  --append-system-prompt <text>   Preserve and extend CodeBuddy's system prompt",
    "  --system-prompt-file <path>     Replace system prompt from file",
    "",
    "Sessions:",
    "  --persistent                    Save a new one-shot session",
    "  --continue                      Continue the latest session",
    "  --resume <session-id>           Resume a known session",
    "  --resume-from-account <alias>   Copy that account's local session before resuming",
    "  --fork-session                  Fork when resuming instead of reusing the session ID",
    "",
    "Other:",
    "  --include-partial-messages      stream-json only",
    "  --dry-run                       Print redacted invocation without calling CodeBuddy",
    "  --debug                         Print redacted diagnostics to stderr",
  ].join("\n");
}

function executable(pathname) {
  try {
    fs.accessSync(pathname, WIN ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(names) {
  const extensions = WIN ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(directory, name + extension);
        if (executable(candidate)) return candidate;
      }
    }
  }
  return null;
}

function resolveCodeBuddyBin({ allowFallback = false } = {}) {
  const override = process.env.CODEBUDDYCN_BIN || process.env.CODEBUDDY_BIN;
  if (override) {
    const looksLikePath = override.includes("/") || override.includes("\\") || path.isAbsolute(override);
    const resolved = looksLikePath ? path.resolve(override) : findInPath([override]);
    if (resolved && executable(resolved)) return resolved;
    throw new CliError("invalid_binary", `CODEBUDDYCN_BIN/CODEBUDDY_BIN does not resolve to an executable: ${override}`);
  }

  const onPath = findInPath(["codebuddy", "codebuddy-code", "cbc"]);
  if (onPath) return onPath;

  const home = os.homedir();
  const candidates = WIN
    ? [
        path.join(home, ".codebuddy", "bin", "codebuddy.exe"),
        path.join(home, ".codebuddy", "bin", "cbc.exe"),
        path.join(home, "AppData", "Roaming", "npm", "codebuddy.cmd"),
        path.join(home, "AppData", "Roaming", "npm", "cbc.cmd"),
      ]
    : [
        path.join(home, ".local", "bin", "codebuddy"),
        path.join(home, ".codebuddy", "bin", "codebuddy"),
        path.join(home, ".codebuddy", "bin", "cbc"),
      ];
  const found = candidates.find(executable);
  if (found) return found;
  if (allowFallback) return "codebuddy";
  throw new CliError(
    "codebuddy_not_found",
    "CodeBuddy Code CLI was not found. Install the official CLI, run `codebuddy`, and choose Chinese Site. The CodeBuddy CN IDE command `buddycn` is not a headless substitute.",
  );
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new CliError("invalid_value", `${name} must be a positive integer`);
  return number;
}

function readTextFile(filename, purpose) {
  const absolute = path.resolve(filename);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new CliError("file_not_found", `${purpose} not found: ${absolute}`);
  }
  if (!stat.isFile()) throw new CliError("not_a_file", `${purpose} is not a regular file: ${absolute}`);
  if (stat.size > MAX_INPUT_BYTES) throw new CliError("input_too_large", `${purpose} exceeds 20 MiB: ${absolute}`);
  const content = fs.readFileSync(absolute, "utf8");
  if (content.includes("\0")) throw new CliError("binary_input", `${purpose} appears to be binary: ${absolute}`);
  return { absolute, content, bytes: Buffer.byteLength(content) };
}

function parseArgs(argv) {
  const opts = {
    prompt: "",
    promptFile: "",
    inputFiles: [],
    backend: "sdk",
    account: "",
    model: "",
    format: "json",
    schemaFile: "",
    maxTurns: 1,
    timeoutMs: 600_000,
    cwd: process.cwd(),
    agent: "cli",
    tools: "",
    addDirs: [],
    allowedTools: [],
    disallowedTools: [],
    permissionMode: "",
    skipPermissions: false,
    settingSources: "user",
    appendSystemPrompt: "",
    systemPromptFile: "",
    persistent: false,
    continueSession: false,
    resume: "",
    resumeFromAccount: "",
    forkSession: false,
    includePartialMessages: false,
    dryRun: false,
    debug: false,
  };

  const bare = [];
  const need = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined) throw new CliError("missing_value", `${flag} requires a value`);
    return value;
  };

  let positionalOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (positionalOnly) {
      bare.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    switch (arg) {
      case "--prompt": opts.prompt = need(i, arg); i += 1; break;
      case "--prompt-file": opts.promptFile = need(i, arg); i += 1; break;
      case "--input-file": opts.inputFiles.push(need(i, arg)); i += 1; break;
      case "--backend": opts.backend = need(i, arg); i += 1; break;
      case "--account": opts.account = need(i, arg); i += 1; break;
      case "--model": opts.model = need(i, arg); i += 1; break;
      case "--format": opts.format = need(i, arg); i += 1; break;
      case "--json-schema-file": opts.schemaFile = need(i, arg); i += 1; break;
      case "--max-turns": opts.maxTurns = parsePositiveInteger(need(i, arg), arg); i += 1; break;
      case "--timeout": opts.timeoutMs = parsePositiveInteger(need(i, arg), arg) * 1000; i += 1; break;
      case "--cwd": opts.cwd = need(i, arg); i += 1; break;
      case "--agent": opts.agent = need(i, arg); i += 1; break;
      case "--tools": {
        const value = need(i, arg);
        opts.tools = value === "none" ? "" : value;
        i += 1;
        break;
      }
      case "--add-dir": opts.addDirs.push(need(i, arg)); i += 1; break;
      case "--allowed-tool": opts.allowedTools.push(need(i, arg)); i += 1; break;
      case "--disallowed-tool": opts.disallowedTools.push(need(i, arg)); i += 1; break;
      case "--permission-mode": opts.permissionMode = need(i, arg); i += 1; break;
      case "--skip-permissions": opts.skipPermissions = true; break;
      case "--setting-sources": opts.settingSources = need(i, arg); i += 1; break;
      case "--append-system-prompt": opts.appendSystemPrompt = need(i, arg); i += 1; break;
      case "--system-prompt-file": opts.systemPromptFile = need(i, arg); i += 1; break;
      case "--persistent": opts.persistent = true; break;
      case "--continue": opts.continueSession = true; break;
      case "--resume": opts.resume = need(i, arg); i += 1; break;
      case "--resume-from-account": opts.resumeFromAccount = need(i, arg); i += 1; break;
      case "--fork-session": opts.forkSession = true; break;
      case "--include-partial-messages": opts.includePartialMessages = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--debug": opts.debug = true; break;
      case "-h":
      case "--help": throw new CliError("help", usage(), 0);
      default:
        if (arg.startsWith("-")) throw new CliError("unknown_flag", `unknown flag: ${arg}`);
        bare.push(arg);
    }
  }

  if (bare.length) opts.prompt = [opts.prompt, bare.join(" ")].filter(Boolean).join(" ");
  if (opts.prompt && opts.promptFile) throw new CliError("conflicting_prompt", "use either --prompt/bare text or --prompt-file, not both");
  if (!opts.prompt && !opts.promptFile) throw new CliError("missing_prompt", `a prompt is required\n${usage()}`);
  if (!new Set(["text", "json", "stream-json"]).has(opts.format)) {
    throw new CliError("invalid_format", "--format must be text, json, or stream-json");
  }
  if (!new Set(["sdk", "cli"]).has(opts.backend)) {
    throw new CliError("invalid_backend", "--backend must be sdk or cli");
  }
  if (opts.includePartialMessages && opts.format !== "stream-json") {
    throw new CliError("invalid_combination", "--include-partial-messages requires --format stream-json");
  }
  if (opts.schemaFile && opts.format !== "json") {
    throw new CliError("invalid_combination", "--json-schema-file requires --format json");
  }
  if (opts.continueSession && opts.resume) {
    throw new CliError("conflicting_session", "--continue and --resume are mutually exclusive");
  }
  if (opts.resume) validateSessionId(opts.resume);
  if (opts.resumeFromAccount && !opts.resume) {
    throw new CliError("invalid_combination", "--resume-from-account requires --resume SESSION_ID");
  }
  if (opts.resumeFromAccount && !opts.account) {
    throw new CliError("missing_account", "cross-account resume requires --account TARGET_ALIAS");
  }
  if (opts.resumeFromAccount && opts.format !== "json") {
    throw new CliError("invalid_combination", "cross-account resume currently requires --format json so the forked session ID and cleanup can be verified");
  }
  if (opts.resumeFromAccount && opts.account === opts.resumeFromAccount) {
    throw new CliError("same_session_account", "source and target account aliases are the same; omit --resume-from-account for a normal resume");
  }
  if (opts.account === "auto" && (opts.continueSession || opts.resume)) {
    throw new CliError("unsafe_account_session", "--account auto cannot be combined with --continue or --resume; use an explicit account alias");
  }
  if (opts.resumeFromAccount === "auto") {
    throw new CliError("unsafe_account_session", "--resume-from-account requires a fixed source account alias");
  }
  if (opts.forkSession && !opts.continueSession && !opts.resume) {
    throw new CliError("invalid_combination", "--fork-session requires --continue or --resume");
  }
  if (opts.resumeFromAccount) opts.forkSession = true;
  if (opts.skipPermissions && opts.tools === "") {
    throw new CliError("unsafe_noop", "--skip-permissions is not allowed while tools are disabled; remove it or explicitly scope --tools");
  }
  const modes = new Set(["default", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"]);
  if (opts.permissionMode && !modes.has(opts.permissionMode)) {
    throw new CliError("invalid_permission_mode", `unsupported --permission-mode: ${opts.permissionMode}`);
  }
  return opts;
}

async function readPipedStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new CliError("input_too_large", "piped stdin exceeds 20 MiB");
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks).toString("utf8");
  if (content.includes("\0")) throw new CliError("binary_input", "piped stdin appears to be binary");
  return content;
}

function sanitize(text) {
  return text
    .replace(/(CODEBUDDY_(?:API_KEY|AUTH_TOKEN)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/("(?:apiKey|api_key|authToken|auth_token|access_token|refresh_token|token|password)"\s*:\s*")[^"]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:password|token|api_key)=)[^\s&]+/gi, "$1[REDACTED]");
}

function redactedArgs(args, prompt, promptIndex) {
  const hiddenAfter = new Set(["--append-system-prompt", "--json-schema"]);
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (i === promptIndex) {
      result.push(`<prompt:${Buffer.byteLength(prompt)} bytes>`);
    } else if (i > 0 && hiddenAfter.has(args[i - 1])) {
      result.push(`<redacted:${Buffer.byteLength(arg)} bytes>`);
    } else {
      result.push(arg);
    }
  }
  return result;
}

function sdkFailureCode(result, detail) {
  const categories = [
    result?.errors_info?.category,
    result?.error_info?.category,
    ...(Array.isArray(result?.errors_info) ? result.errors_info.map((item) => item?.category) : []),
  ].filter((value) => typeof value === "string").join(" ").toLowerCase();
  const haystack = `${categories} ${detail}`.toLowerCase();
  if (/quota|rate.?limit|insufficient|额度|配额/.test(haystack)) return "quota_exhausted";
  if (/auth|login|log in|sign in|token|unauthori[sz]ed|认证|登录/.test(haystack)) return "authentication_required";
  if (/network|dns|socket|connect|timeout|econn|网络/.test(haystack)) return "network_error";
  if (/cancel|abort|interrupt|取消|中断/.test(haystack)) return "cancelled";
  if (/model.?service|upstream|overload|模型服务/.test(haystack)) return "model_service_error";
  return "codebuddy_failed";
}

function parseEvents(events) {
  const init = events.find((event) => event?.type === "system" && event?.subtype === "init");
  const result = [...events].reverse().find((event) => event?.type === "result");
  const errorEvent = [...events].reverse().find((event) => event?.type === "error");
  const assistantText = events.flatMap((event) => {
    if (event?.type !== "assistant" || !Array.isArray(event?.message?.content)) return [];
    return event.message.content
      .filter((block) => block?.type === "text" || block?.type === "output_text")
      .map((block) => block.text)
      .filter((text) => typeof text === "string");
  }).join("");

  if (result?.is_error || (typeof result?.subtype === "string" && result.subtype.startsWith("error"))) {
    const rawDetail = [
      typeof result.result === "string" ? result.result : "",
      ...(Array.isArray(result.errors) ? result.errors : []),
    ].filter(Boolean).join("; ");
    const detail = sanitize(rawDetail || "CodeBuddy reported an error result").slice(0, 1000);
    const code = sdkFailureCode(result, detail);
    throw new CliError(code, detail, code === "authentication_required" ? 2 : 1);
  }
  if (!result && errorEvent) {
    const raw = errorEvent.message || errorEvent.error || "CodeBuddy SDK reported an error";
    const detail = sanitize(typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 1000);
    throw new CliError(sdkFailureCode(errorEvent, detail), detail);
  }

  const resultText = typeof result?.result === "string" ? result.result : "";
  const text = resultText || assistantText;
  const structuredOutput = result?.structured_output ?? result?.structuredOutput ?? null;
  if (!text && structuredOutput === null) {
    throw new CliError("empty_response", "CodeBuddy returned events but no final model response");
  }

  return {
    response: {
      text: text || null,
      structured_output: structuredOutput,
    },
    modelUsed: init?.model
      || [...events].reverse().find((event) => event?.type === "assistant")?.message?.model
      || null,
    sessionId: init?.session_id ?? init?.sessionId ?? result?.session_id ?? result?.sessionId ?? null,
    resultMeta: result ? {
      duration_ms: result.duration_ms ?? null,
      duration_api_ms: result.duration_api_ms ?? null,
      num_turns: result.num_turns ?? null,
      total_cost_usd: result.total_cost_usd ?? null,
      usage: result.usage ?? null,
      model_usage: result.model_usage ?? result.modelUsage ?? null,
      permission_denials: result.permission_denials ?? [],
      errors_info: result.errors_info ?? result.error_info ?? null,
    } : null,
  };
}

function parseStreamResult(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new CliError("invalid_cli_output", "CodeBuddy returned an invalid stream-json event");
    }
  }
  return parseEvents(events);
}

function splitCsv(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function sdkTools(value) {
  if (value === "default") return undefined;
  return splitCsv(value);
}

function sdkModuleSpecifier() {
  const override = process.env.CODEBUDDYCN_SDK_MODULE;
  if (!override) return "@tencent-ai/agent-sdk";
  if (override.startsWith("file:") || !path.isAbsolute(override)) return override;
  return pathToFileURL(override).href;
}

async function loadAgentSdk() {
  const specifier = sdkModuleSpecifier();
  let sdk;
  try {
    sdk = await import(specifier);
  } catch (error) {
    const detail = sanitize(error?.message || String(error));
    throw new CliError(
      "sdk_not_available",
      `CodeBuddy Agent SDK could not be loaded (${detail}). Run \`npm ci --omit=dev\` in the skill directory, or explicitly use \`--backend cli\`. No model request was sent.`,
    );
  }
  if (typeof sdk?.query !== "function") {
    throw new CliError(
      "invalid_sdk",
      "The configured CodeBuddy Agent SDK module does not export query(). No model request was sent.",
    );
  }
  return sdk;
}

function sdkThrownError(error) {
  if (error instanceof CliError) return error;
  const detail = sanitize(error?.message || String(error)).slice(0, 1000);
  const name = String(error?.name || "");
  const code = sdkFailureCode(error, `${name} ${detail}`);
  if (name === "CLIStartupError") {
    return new CliError("sdk_startup_failed", `CodeBuddy SDK could not start its CLI transport: ${detail}`);
  }
  return new CliError(code, detail || "CodeBuddy SDK request failed", code === "authentication_required" ? 2 : 1);
}

async function runSdk(sdk, prompt, options, { timeoutMs, stream, debug, onQuery }) {
  const abortController = new AbortController();
  options.abortController = abortController;
  const events = [];
  let timedOut = false;
  let queryHandle = null;
  let timer = null;
  try {
    queryHandle = sdk.query({ prompt, options });
    if (!queryHandle || typeof queryHandle[Symbol.asyncIterator] !== "function") {
      throw new CliError("invalid_sdk", "CodeBuddy Agent SDK query() did not return an async iterator");
    }
    onQuery?.({ queryHandle, abortController });
    timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      Promise.resolve(queryHandle?.interrupt?.()).catch(() => {});
    }, timeoutMs);

    for await (const event of queryHandle) {
      events.push(event);
      if (stream) process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    if (timedOut) {
      throw new CliError("timeout", `CodeBuddy timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    return { events };
  } catch (error) {
    if (timedOut) {
      throw new CliError("timeout", `CodeBuddy timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    if (debug) process.stderr.write(`DEBUG CodeBuddy SDK error: ${sanitize(error?.message || String(error))}\n`);
    throw sdkThrownError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runChild(bin, args, { cwd, env, input, timeoutMs, stream, debug, onSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    onSpawn?.(child);
    let stdout = "";
    let stderr = "";
    let sawStdout = false;
    let settled = false;
    let timedOut = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      sawStdout = true;
      if (stream) process.stdout.write(text);
      else stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = sanitize(chunk.toString());
      stderr += text;
      if (debug) process.stderr.write(text);
    });
    child.on("error", (error) => finish({ code: -1, stdout, stderr, sawStdout, timedOut, spawnError: error.message }));
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr, sawStdout, timedOut }));

    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

function emptyResponseError(stderr) {
  const detail = sanitize(stderr || "").trim();
  if (/authentication required|use \/login|not logged in|please (?:sign|log) in/i.test(detail)) {
    return new CliError(
      "authentication_required",
      "CodeBuddy CN is not logged in. Run `codebuddy` interactively, enter `/login`, and choose Chinese Site.",
      2,
    );
  }
  const suffix = detail ? ` CLI diagnostic: ${detail.slice(-1000)}` : "";
  return new CliError("empty_response", `CodeBuddy exited successfully but returned no model response.${suffix}`);
}

async function recordRunBestEffort(accountRuntime, success, failureCode, debug) {
  if (!accountRuntime) return;
  try {
    await recordAccountRun(accountRuntime.alias, success, failureCode);
  } catch (error) {
    if (debug) process.stderr.write(`DEBUG account counter update failed: ${sanitize(error?.message || String(error))}\n`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const cwd = path.resolve(opts.cwd);
  let cwdStat;
  try {
    cwdStat = fs.statSync(cwd);
  } catch {
    throw new CliError("cwd_not_found", `working directory not found: ${cwd}`);
  }
  if (!cwdStat.isDirectory()) throw new CliError("invalid_cwd", `--cwd is not a directory: ${cwd}`);

  let prompt = opts.prompt;
  if (opts.promptFile) prompt = readTextFile(opts.promptFile, "prompt file").content.trim();
  if (!prompt) throw new CliError("empty_prompt", "prompt is empty");

  const inputParts = [];
  const inputMeta = [];
  for (const filename of opts.inputFiles) {
    const item = readTextFile(filename, "input file");
    inputParts.push(`<codebuddy-skill-context path=${JSON.stringify(item.absolute)}>\n${item.content}\n</codebuddy-skill-context>`);
    inputMeta.push({ path: item.absolute, bytes: item.bytes });
  }
  const piped = await readPipedStdin();
  if (piped) {
    inputParts.push(`<codebuddy-skill-stdin>\n${piped}\n</codebuddy-skill-stdin>`);
    inputMeta.push({ path: "<stdin>", bytes: Buffer.byteLength(piped) });
  }
  const input = inputParts.join("\n\n");
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new CliError("input_too_large", "combined context exceeds 20 MiB");

  const addDirs = opts.addDirs.map((directory) => {
    const absolute = path.resolve(cwd, directory);
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch {
      throw new CliError("add_dir_not_found", `--add-dir not found: ${absolute}`);
    }
    if (!stat.isDirectory()) throw new CliError("invalid_add_dir", `--add-dir is not a directory: ${absolute}`);
    return absolute;
  });

  let schema = "";
  let schemaObject = null;
  if (opts.schemaFile) {
    const schemaText = readTextFile(opts.schemaFile, "JSON schema file").content;
    try {
      schemaObject = JSON.parse(schemaText);
      if (!schemaObject || typeof schemaObject !== "object" || Array.isArray(schemaObject)) {
        throw new Error("schema root must be a JSON object");
      }
      schema = JSON.stringify(schemaObject);
    } catch (error) {
      throw new CliError("invalid_json_schema", `JSON schema file is invalid: ${error.message}`);
    }
  }

  let systemPromptFile = null;
  if (opts.systemPromptFile) systemPromptFile = readTextFile(opts.systemPromptFile, "system prompt file");

  const effectiveTools = schema
    ? (opts.tools === "" ? "StructuredOutput" : opts.tools === "default" || /(?:^|,)\s*StructuredOutput\s*(?:,|$)/i.test(opts.tools)
      ? opts.tools
      : `${opts.tools},StructuredOutput`)
    : opts.tools;

  // Native `json` currently serializes the whole conversation, including large
  // injected reminders, and some releases can truncate that document. Collect
  // JSONL internally and expose only the final answer plus useful metadata.
  const nativeFormat = opts.format === "json" ? "stream-json" : opts.format;
  const args = [
    "--agent", opts.agent,
    "-p",
    "--output-format", nativeFormat,
    "--max-turns", String(opts.maxTurns),
    "--tools", effectiveTools,
  ];
  if (opts.settingSources) args.push("--setting-sources", opts.settingSources);
  if (!opts.persistent && !opts.continueSession && !opts.resume) args.push("--no-session-persistence");
  if (opts.model) args.push("--model", opts.model);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (opts.skipPermissions) args.push("--dangerously-skip-permissions");
  if (opts.continueSession) args.push("--continue");
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.forkSession) args.push("--fork-session");
  for (const directory of addDirs) args.push("--add-dir", directory);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (systemPromptFile) args.push("--system-prompt-file", systemPromptFile.absolute);
  if (schema) args.push("--json-schema", schema);
  if (opts.includePartialMessages) args.push("--include-partial-messages");
  args.push(prompt);
  const promptIndex = args.length - 1;
  // These CodeBuddy flags accept a variable number of values. Put them after the
  // positional prompt so they can never consume the prompt as another tool spec.
  if (opts.allowedTools.length) args.push("--allowedTools", ...opts.allowedTools);
  if (opts.disallowedTools.length) args.push("--disallowedTools", ...opts.disallowedTools);

  const bin = resolveCodeBuddyBin({ allowFallback: opts.dryRun });
  const displayArgs = redactedArgs(args, prompt, promptIndex);
  const sdkPrompt = [input, prompt].filter(Boolean).join("\n\n");
  let sdkSystemPrompt;
  if (systemPromptFile && opts.appendSystemPrompt) {
    sdkSystemPrompt = `${systemPromptFile.content}\n\n${opts.appendSystemPrompt}`;
  } else if (systemPromptFile) {
    sdkSystemPrompt = systemPromptFile.content;
  } else if (opts.appendSystemPrompt) {
    sdkSystemPrompt = { append: opts.appendSystemPrompt };
  }
  const sdkOptionsBase = {
    pathToCodebuddyCode: bin,
    cwd,
    additionalDirectories: addDirs.length ? addDirs : undefined,
    model: opts.model || undefined,
    tools: sdkTools(effectiveTools),
    allowedTools: opts.allowedTools.length ? opts.allowedTools : undefined,
    disallowedTools: opts.disallowedTools.length ? opts.disallowedTools : undefined,
    permissionMode: opts.permissionMode || undefined,
    allowDangerouslySkipPermissions: opts.skipPermissions || undefined,
    continue: opts.continueSession || undefined,
    resume: opts.resume || undefined,
    forkSession: opts.forkSession || undefined,
    persistSession: opts.persistent || opts.continueSession || Boolean(opts.resume),
    maxTurns: opts.maxTurns,
    settingSources: splitCsv(opts.settingSources),
    includePartialMessages: opts.includePartialMessages || undefined,
    systemPrompt: sdkSystemPrompt,
    outputFormat: schemaObject ? { type: "json_schema", schema: schemaObject } : undefined,
    extraArgs: opts.agent && opts.agent !== "cli" ? { agent: opts.agent } : undefined,
  };
  if (opts.debug) {
    if (opts.backend === "cli") {
      process.stderr.write(`DEBUG CodeBuddy CLI spawn: ${bin} ${displayArgs.map((arg) => JSON.stringify(arg)).join(" ")}\n`);
    } else {
      process.stderr.write(`DEBUG CodeBuddy SDK: bin=${JSON.stringify(bin)} option_keys=${JSON.stringify(Object.keys(sdkOptionsBase).filter((key) => sdkOptionsBase[key] !== undefined))}\n`);
    }
    process.stderr.write(`DEBUG cwd=${cwd} context_bytes=${Buffer.byteLength(input)} prompt_bytes=${Buffer.byteLength(prompt)}\n`);
  }

  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dry_run: true,
      schema_version: "1",
      backend: opts.backend,
      bin,
      cwd,
      sdk: opts.backend === "sdk" ? {
        package: "@tencent-ai/agent-sdk",
        prompt_bytes: Buffer.byteLength(sdkPrompt),
        options: {
          pathToCodebuddyCode: bin,
          cwd,
          additionalDirectories: addDirs,
          model: opts.model || null,
          tools: sdkOptionsBase.tools === undefined ? "default" : sdkOptionsBase.tools,
          allowedTools: opts.allowedTools,
          disallowedTools: opts.disallowedTools,
          permissionMode: opts.permissionMode || null,
          allowDangerouslySkipPermissions: opts.skipPermissions,
          continue: opts.continueSession,
          resume: opts.resume || null,
          forkSession: opts.forkSession,
          persistSession: sdkOptionsBase.persistSession,
          maxTurns: opts.maxTurns,
          settingSources: sdkOptionsBase.settingSources,
          includePartialMessages: opts.includePartialMessages,
          hasSystemPrompt: sdkSystemPrompt !== undefined,
          hasOutputSchema: Boolean(schemaObject),
        },
      } : null,
      cli_fallback: {
        explicit_only: true,
        args: displayArgs,
      },
      input: inputMeta,
      context_bytes: Buffer.byteLength(input),
      account_requested: opts.account || null,
      safety: {
        no_automatic_backend_fallback: true,
        tools: effectiveTools || "disabled",
        skip_permissions: opts.skipPermissions,
        setting_sources: opts.settingSources,
        persistent: opts.persistent || opts.continueSession || Boolean(opts.resume),
        cross_account_resume: opts.resumeFromAccount ? {
          source_account: opts.resumeFromAccount,
          target_account: opts.account,
          session_id: opts.resume,
          fork_session: true,
          mutates_local_session_store: true,
        } : null,
      },
    }, null, 2)}\n`);
    return 0;
  }

  const sdk = opts.backend === "sdk" ? await loadAgentSdk() : null;
  const accountRuntime = opts.account ? await prepareAccountRuntime(opts.account) : null;
  let sessionTransfer = null;
  if (opts.resumeFromAccount) {
    if (!accountRuntime?.sessionUid) {
      throw new CliError("account_uid_missing", `account ${accountRuntime?.alias || opts.account} has no UID for local session transfer`);
    }
    const sourceIdentity = await getAccountSessionIdentity(opts.resumeFromAccount);
    sessionTransfer = await transferSessionForAccount({
      sessionId: opts.resume,
      sourceUid: sourceIdentity.uid,
      targetUid: accountRuntime.sessionUid,
    });
    if (opts.debug) {
      process.stderr.write(`DEBUG cross-account session transfer: ${JSON.stringify({
        source_account: sourceIdentity.alias,
        target_account: accountRuntime.alias,
        workspaces: sessionTransfer.workspaces,
        added: sessionTransfer.added,
        replaced: sessionTransfer.replaced,
        kept_newer: sessionTransfer.kept_newer,
        database_rows: sessionTransfer.database_rows,
        backup_dir: sessionTransfer.backup_dir,
      })}\n`);
    }
  }
  const childEnv = { ...process.env };
  if (accountRuntime) {
    delete childEnv.CODEBUDDY_API_KEY;
    delete childEnv.CODEBUDDY_API_KEY_HELPER;
    delete childEnv.CODEBUDDY_CUSTOM_HEADERS;
    Object.assign(childEnv, accountRuntime.environment);
  }

  const startedAt = Date.now();
  let execution = null;
  let executionError = null;
  let activeChild = null;
  let activeQuery = null;
  let activeAbortController = null;
  let sdkStderr = "";
  let sessionRestore = null;
  let sessionRestoreError = null;
  let terminating = false;
  const terminateWithCleanup = (signal) => {
    if (terminating) return;
    terminating = true;
    try { activeChild?.kill("SIGTERM"); } catch {}
    try { activeAbortController?.abort(); } catch {}
    Promise.resolve(activeQuery?.interrupt?.())
      .catch(() => {})
      .then(() => (sessionTransfer ? restoreTransferredSession(sessionTransfer) : null))
      .catch(() => {})
      .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  const handleSigint = () => terminateWithCleanup("SIGINT");
  const handleSigterm = () => terminateWithCleanup("SIGTERM");
  if (sessionTransfer) {
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
  }
  try {
    if (opts.backend === "sdk") {
      const sdkOptions = {
        ...sdkOptionsBase,
        env: childEnv,
        stderr: (data) => {
          const safe = sanitize(String(data));
          sdkStderr += safe;
          if (opts.debug) process.stderr.write(safe);
        },
      };
      execution = await runSdk(sdk, sdkPrompt, sdkOptions, {
        timeoutMs: opts.timeoutMs,
        stream: opts.format === "stream-json",
        debug: opts.debug,
        onQuery: ({ queryHandle, abortController }) => {
          activeQuery = queryHandle;
          activeAbortController = abortController;
        },
      });
    } else {
      execution = await runChild(bin, args, {
        cwd,
        env: childEnv,
        input,
        timeoutMs: opts.timeoutMs,
        stream: opts.format === "stream-json",
        debug: opts.debug,
        onSpawn: (spawned) => { activeChild = spawned; },
      });
    }
  } catch (error) {
    executionError = error;
  } finally {
    if (sessionTransfer) {
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
    }
    if (sessionTransfer) {
      try {
        sessionRestore = await restoreTransferredSession(sessionTransfer);
      } catch (error) {
        sessionRestoreError = error;
      }
    }
  }
  const elapsedMs = Date.now() - startedAt;

  let parsed = null;
  try {
    if (executionError) throw executionError;
    if (opts.backend === "sdk") {
      if (!execution?.events?.length) throw emptyResponseError(sdkStderr);
      parsed = parseEvents(execution.events);
    } else {
      const child = execution;
      if (child.spawnError) throw new CliError("spawn_failed", `could not launch CodeBuddy CLI: ${child.spawnError}`);
      if (child.timedOut) throw new CliError("timeout", `CodeBuddy timed out after ${Math.round(opts.timeoutMs / 1000)} seconds`);

      if (opts.format === "stream-json") {
        if (child.code !== 0) throw new CliError("codebuddy_failed", `CodeBuddy exited with code ${child.code}${child.signal ? ` (${child.signal})` : ""}`, child.code || 1);
        if (!child.sawStdout) throw emptyResponseError(child.stderr);
      } else {
        if (child.code !== 0) {
          if (/authentication required|use \/login|not logged in|please (?:sign|log) in/i.test(`${child.stderr}\n${child.stdout}`)) {
            throw emptyResponseError(`${child.stderr}\n${child.stdout}`);
          }
          throw new CliError(
            "codebuddy_failed",
            `CodeBuddy exited with code ${child.code}. Run CodeBuddy interactively for login/account errors, or retry with --debug only when its diagnostics are safe to expose.`,
            child.code || 1,
          );
        }

        if (!child.stdout.trim()) throw emptyResponseError(child.stderr);
        if (opts.format === "json") parsed = parseStreamResult(child.stdout);
      }
    }
  } catch (error) {
    await recordRunBestEffort(accountRuntime, false, error?.code || "codebuddy_failed", opts.debug);
    if (sessionRestoreError) {
      throw new CliError(
        "session_restore_failed",
        `CodeBuddy request failed and staged cross-account session data could not be fully restored. Do not retry automatically. ${sanitize(sessionRestoreError.message || String(sessionRestoreError))}`,
      );
    }
    throw error;
  }
  await recordRunBestEffort(accountRuntime, true, "", opts.debug);

  if (opts.format === "stream-json") return 0;

  if (opts.format === "text") {
    const text = opts.backend === "sdk" ? (parsed.response.text || "") : execution.stdout;
    process.stdout.write(text);
    if (text && !text.endsWith("\n")) process.stdout.write("\n");
    return 0;
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema_version: "1",
    backend: opts.backend,
    via: opts.backend === "sdk" ? "codebuddy-agent-sdk-chinese-site" : "codebuddy-code-cli-chinese-site",
    model_requested: opts.model || null,
    model_used: parsed.modelUsed,
    account: accountRuntime?.public || null,
    session: {
      id: parsed.sessionId || (!opts.forkSession && opts.resume ? opts.resume : null),
      resumed_from: opts.resume || null,
      forked: opts.forkSession,
      source_account: opts.resumeFromAccount || null,
      warning: sessionRestoreError
        ? `The model request completed, but staged local session data could not be fully restored. Do not retry automatically. ${sanitize(sessionRestoreError.message || String(sessionRestoreError))}`
        : opts.resumeFromAccount && (!parsed.sessionId || parsed.sessionId === opts.resume)
          ? `The model request completed, but the ${opts.backend.toUpperCase()} backend did not confirm a distinct forked session ID. Do not replay the prompt automatically.`
          : null,
      transfer: sessionTransfer ? {
        workspaces: sessionTransfer.workspaces,
        added: sessionTransfer.added,
        replaced: sessionTransfer.replaced,
        kept_newer: sessionTransfer.kept_newer,
        database_rows: sessionTransfer.database_rows,
        backup_dir: sessionTransfer.backup_dir,
        restored_after_fork: sessionRestore?.restored === true,
      } : null,
    },
    elapsed_ms: elapsedMs,
    response: parsed.response,
    result: parsed.resultMeta,
  })}\n`);
  return 0;
}

function outputError(error) {
  const formatIndex = process.argv.indexOf("--format");
  const format = formatIndex >= 0 ? process.argv[formatIndex + 1] : "json";
  if (error instanceof CliError && error.code === "help") {
    process.stdout.write(`${error.message}\n`);
    process.exit(0);
  }
  if (format === "text" || format === "stream-json") {
    process.stderr.write(`${sanitize(error.message || String(error))}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      schema_version: "1",
      error: {
        code: error.code || "unexpected_error",
        message: sanitize(error.message || String(error)),
      },
    })}\n`);
  }
  process.exit(error.exitCode || 1);
}

main().then((code) => process.exit(code)).catch(outputError);
