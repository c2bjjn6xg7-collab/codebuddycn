#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listAccountMetadata } from "./codebuddycn-accounts.mjs";

const JSON_OUT = process.argv.includes("--json");
const WIN = process.platform === "win32";

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

function resolveOverride(value) {
  if (!value) return null;
  const looksLikePath = value.includes("/") || value.includes("\\") || path.isAbsolute(value);
  if (looksLikePath) {
    const candidate = path.resolve(value);
    return executable(candidate) ? candidate : null;
  }
  return findInPath([value]);
}

function resolveCodeBuddyBin() {
  const override = resolveOverride(process.env.CODEBUDDYCN_BIN || process.env.CODEBUDDY_BIN);
  if (override) return override;

  const fromPath = findInPath(["codebuddy", "codebuddy-code", "cbc"]);
  if (fromPath) return fromPath;

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
  return candidates.find(executable) || null;
}

function capture(bin, args, timeout = 10_000) {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    }).trim();
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    return `${stdout}\n${stderr}`.trim();
  }
}

function acceptsOption(bin, flag, value) {
  if (!bin) return false;
  try {
    const args = value === undefined ? [flag, "--version"] : [flag, value, "--version"];
    execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function nodeAtLeast1820() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 18 || (major === 18 && minor >= 20);
}

function detectIdeCli() {
  const home = os.homedir();
  const candidates = [];
  const onPath = findInPath(["buddycn"]);
  if (onPath) candidates.push(onPath);

  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/CodeBuddy CN.app/Contents/Resources/app/bin/code",
      "/Applications/CodeBuddy.app/Contents/Resources/app/bin/code",
      path.join(home, "Applications", "CodeBuddy CN.app", "Contents", "Resources", "app", "bin", "code"),
      path.join(home, ".codebuddy", "bin", "buddycn"),
    );
  }
  return [...new Set(candidates)].find(executable) || null;
}

const cliBin = resolveCodeBuddyBin();
const versionText = cliBin ? capture(cliBin, ["--version"]) : "";
const helpText = cliBin ? capture(cliBin, ["--help"]) : "";
const firstVersionLine = versionText.split(/\r?\n/).find(Boolean) || "";

const capabilities = {
  print: /--print|(?:^|\s)-p(?:,|\s)/m.test(helpText),
  output_format: /--output-format/.test(helpText),
  model: /--model/.test(helpText),
  tools: /--tools/.test(helpText),
  // Some CodeBuddy releases truncate piped --help near 8 KiB. Probe late
  // options with --version as a side-effect-free fallback.
  setting_sources: /--setting-sources/.test(helpText) || acceptsOption(cliBin, "--setting-sources", "user"),
  no_session_persistence: /--no-session-persistence/.test(helpText) || acceptsOption(cliBin, "--no-session-persistence"),
};

const headlessReady = Boolean(cliBin && capabilities.print && capabilities.output_format);
const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkPackagePath = path.join(skillRoot, "node_modules", "@tencent-ai", "agent-sdk", "package.json");
const sdkEntrypoint = path.join(skillRoot, "node_modules", "@tencent-ai", "agent-sdk", "lib", "index.js");
let sdkVersion = null;
try {
  sdkVersion = JSON.parse(fs.readFileSync(sdkPackagePath, "utf8")).version || null;
} catch {}
let sdkReady = false;
let sdkImportError = null;
if (sdkVersion && fs.existsSync(sdkEntrypoint)) {
  try {
    const sdk = await import(pathToFileURL(sdkEntrypoint).href);
    sdkReady = typeof sdk?.query === "function";
    if (!sdkReady) sdkImportError = "query_export_missing";
  } catch (error) {
    sdkImportError = String(error?.code || error?.name || "sdk_import_failed");
  }
}
const settingsPath = path.join(os.homedir(), ".codebuddy", "settings.json");
let storedAccounts = [];
let accountStoreDiagnostic = null;
try {
  storedAccounts = listAccountMetadata();
} catch (error) {
  accountStoreDiagnostic = String(error?.code || "invalid_account_store");
}
const auth = {
  api_key_env: Boolean(process.env.CODEBUDDY_API_KEY),
  auth_token_env: Boolean(process.env.CODEBUDDY_AUTH_TOKEN),
  internet_environment: process.env.CODEBUDDY_INTERNET_ENVIRONMENT || null,
  settings_file_present: fs.existsSync(settingsPath),
  stored_account_count: storedAccounts.length,
  account_store_diagnostic: accountStoreDiagnostic,
  login_state: "not-probed",
  note: "OAuth/login secrets are not displayed; stored accounts are read only when --account is used.",
};
const ideCli = detectIdeCli();

const suggestions = [];
if (!cliBin) {
  suggestions.push("CodeBuddy 中国站无头 CLI 未安装：取得用户授权后运行中国站官方原生安装器，或 `npm install -g @tencent-ai/codebuddy-code`；命令仍是 `codebuddy`/`cbc`。");
} else if (!headlessReady) {
  suggestions.push("当前命令缺少 -p 或 --output-format；请确认它是 CodeBuddy Code CLI，并按官方方式更新。");
}
if (!sdkReady) {
  suggestions.push("默认 SDK 后端未就绪：在 skill 目录运行 `npm ci --omit=dev`；临时使用 CLI 必须显式添加 `--backend cli`。");
}
if (auth.api_key_env && auth.internet_environment !== "internal") {
  suggestions.push("检测到 API key；中国站 API key 模式还需要 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`。");
} else if (!auth.api_key_env && !auth.auth_token_env && !auth.stored_account_count) {
  suggestions.push("未探测凭据内容；若首次使用，请由用户运行 `codebuddy`，输入 `/login` 并选择 `Log in via Chinese Site`。");
}
if (ideCli && !cliBin) {
  suggestions.push("检测到 CodeBuddy CN IDE 的 `buddycn`，但它只负责打开 IDE，不能替代无头 `codebuddy -p`。");
}

const report = {
  ok: headlessReady && sdkReady,
  platform: process.platform,
  default_backend: "sdk",
  cli_fallback_ready: headlessReady,
  codebuddy_sdk: {
    installed: Boolean(sdkVersion),
    ready: sdkReady,
    package: "@tencent-ai/agent-sdk",
    version: sdkVersion,
    entrypoint: sdkEntrypoint,
    import_error: sdkImportError,
  },
  codebuddy: {
    installed: Boolean(cliBin),
    bin: cliBin,
    version: firstVersionLine,
    target: "Chinese Site",
    headless_ready: headlessReady,
    capabilities,
  },
  codebuddy_ide: {
    detected: Boolean(ideCli),
    cli: ideCli,
    headless_backend: false,
  },
  node: {
    version: process.version,
    npm_install_requirement_met: nodeAtLeast1820(),
  },
  auth,
  suggestions,
};

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(headlessReady && sdkReady ? 0 : 1);
}

const mark = (value) => (value ? "✅" : "❌");
console.log(`codebuddycn skill · 环境自检 (platform: ${process.platform})`);
console.log("────────────────────────────");
  console.log(`  CodeBuddy CN CLI   : ${mark(Boolean(cliBin))} ${firstVersionLine}`);
  console.log(`  无头 -p/json       : ${mark(headlessReady)}`);
  console.log(`  Agent SDK（默认）  : ${mark(sdkReady)} ${sdkVersion || "未安装"}`);
  console.log(`  CLI 路径           : ${cliBin || "—"}`);
console.log(`  buddycn (IDE 启动器): ${ideCli ? `⚠️ ${ideCli}（仅 UI，不作后端）` : "—"}`);
console.log(`  Node               : ✅ ${process.version} (npm 安装要求: ${nodeAtLeast1820() ? "满足" : "不满足 18.20+"})`);
console.log(`  中国站目标         : Chinese Site（由 CLI 登录选择）`);
console.log(`  环境凭据           : ${auth.api_key_env || auth.auth_token_env ? "已配置（值未读取）" : "未发现；OAuth 登录态未探测"}`);
console.log(`  安全账户库         : ${auth.stored_account_count} 个账户${accountStoreDiagnostic ? `（${accountStoreDiagnostic}）` : ""}`);
console.log(`  Internet env       : ${auth.internet_environment || "—（网页登录模式无需强制设置）"}`);
if (suggestions.length) {
  console.log("────────────────────────────");
  console.log("  建议：");
  for (const suggestion of suggestions) console.log(`   • ${suggestion}`);
}
process.exit(headlessReady && sdkReady ? 0 : 1);
