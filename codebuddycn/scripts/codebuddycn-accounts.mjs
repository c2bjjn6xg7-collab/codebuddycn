#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const KEYCHAIN_SERVICE = "com.openai.codex.skill.codebuddycn.account.v1";
const INDEX_FILE = "accounts-v1.json";
const LOCK_FILE = ".accounts.lock";
const REFRESH_URL = "https://www.codebuddy.cn/v2/plugin/auth/token/refresh";
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_ACCOUNTS = 500;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

export class AccountError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function usage() {
  return [
    "Usage:",
    "  codebuddycn-accounts.mjs import-cockpit <export.json>",
    "  codebuddycn-accounts.mjs sync-labels <export.json>",
    "  codebuddycn-accounts.mjs list [--json]",
    "  codebuddycn-accounts.mjs verify <alias> [--json]",
    "  codebuddycn-accounts.mjs doctor [--json]",
    "  codebuddycn-accounts.mjs remove <alias> --yes",
    "",
    "The credential payload is stored in macOS Keychain, Windows DPAPI, or",
    "Linux Secret Service. Account labels and non-secret counters are kept",
    "in the local index. Use codebuddycn-run.mjs --account <alias|auto> to run.",
  ].join("\n");
}

function sanitizeDiagnostic(value) {
  return String(value || "")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/((?:access|refresh)[_-]?token[\s\"':=]+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .slice(0, 1200);
}

function privateDataRoot() {
  if (process.env.CODEBUDDYCN_ACCOUNT_HOME) {
    return path.resolve(process.env.CODEBUDDYCN_ACCOUNT_HOME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "codebuddycn-skill");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "codebuddycn-skill");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "codebuddycn-skill");
}

function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!IS_WIN) fs.chmodSync(directory, 0o700);
}

function indexPath() {
  return path.join(privateDataRoot(), INDEX_FILE);
}

function defaultIndex() {
  return {
    schema_version: SCHEMA_VERSION,
    next_cursor: 0,
    accounts: [],
  };
}

function loadIndex() {
  const filename = indexPath();
  if (!fs.existsSync(filename)) return defaultIndex();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new AccountError("invalid_account_index", `account index is invalid: ${sanitizeDiagnostic(error.message)}`);
  }
  if (parsed?.schema_version !== SCHEMA_VERSION || !Array.isArray(parsed.accounts)) {
    throw new AccountError("unsupported_account_index", "account index schema is unsupported");
  }
  return parsed;
}

function writePrivateFileAtomic(filename, text) {
  const directory = path.dirname(filename);
  ensurePrivateDir(directory);
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (!IS_WIN) fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filename);
    if (!IS_WIN) fs.chmodSync(filename, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function saveIndex(index) {
  index.schema_version = SCHEMA_VERSION;
  writePrivateFileAtomic(indexPath(), `${JSON.stringify(index, null, 2)}\n`);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function withIndexLock(callback) {
  const root = privateDataRoot();
  ensurePrivateDir(root);
  const filename = path.join(root, LOCK_FILE);
  const deadline = Date.now() + 15_000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(filename, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: Date.now() }), "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(fs.readFileSync(filename, "utf8"));
        const stale = Date.now() - Number(lock.created_at || 0) > 120_000 || !processExists(Number(lock.pid));
        if (stale) {
          fs.rmSync(filename, { force: true });
          continue;
        }
      } catch {
        try {
          if (Date.now() - fs.statSync(filename).mtimeMs > 120_000) {
            fs.rmSync(filename, { force: true });
            continue;
          }
        } catch {}
      }
      if (Date.now() >= deadline) throw new AccountError("account_store_busy", "account credential store is busy");
      await delay(75);
    }
  }
  try {
    return await callback();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(filename, { force: true }); } catch {}
  }
}

function runStrict(program, args, { input = "", env = process.env, timeout = 120_000, maxBuffer = 2 * 1024 * 1024 } = {}) {
  const result = spawnSync(program, args, {
    input,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
    maxBuffer,
  });
  if (result.error) {
    throw new AccountError("credential_backend_failed", `${path.basename(program)} failed: ${sanitizeDiagnostic(result.error.message)}`);
  }
  if (result.status !== 0) {
    const error = new AccountError(
      result.status === 44 ? "credential_not_found" : "credential_backend_failed",
      `${path.basename(program)} failed (${result.status}): ${sanitizeDiagnostic(result.stderr) || "no diagnostic"}`,
    );
    error.backendStatus = result.status;
    throw error;
  }
  return result.stdout;
}

function executable(filename) {
  try {
    fs.accessSync(filename, IS_WIN ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function macHelperPath() {
  const source = path.join(SCRIPT_DIR, "macos-keychain-helper.m");
  if (!fs.existsSync(source)) throw new AccountError("helper_missing", `macOS credential helper source is missing: ${source}`);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(source)).update(process.arch).digest("hex").slice(0, 16);
  const binDir = path.join(privateDataRoot(), "bin");
  const target = path.join(binDir, `credential-helper-${digest}`);
  if (executable(target)) return target;
  ensurePrivateDir(binDir);
  const temporary = `${target}.${process.pid}.tmp`;
  const moduleCache = path.join(binDir, "clang-module-cache");
  ensurePrivateDir(moduleCache);
  try {
    runStrict("/usr/bin/clang", ["-fobjc-arc", source, "-o", temporary, "-framework", "Foundation", "-framework", "Security"], {
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache },
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    fs.chmodSync(temporary, 0o700);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o700);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return target;
}

function powerShellPath() {
  const candidates = [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "",
    "powershell.exe",
    "pwsh.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new AccountError("dpapi_unavailable", "PowerShell is required to use Windows DPAPI");
}

function runPowerShell(script, input, entropy) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const env = { ...process.env, CODEBUDDYCN_DPAPI_ENTROPY: entropy };
  return runStrict(powerShellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { input, env });
}

function windowsSecretPath(alias) {
  const directory = path.join(privateDataRoot(), "dpapi");
  ensurePrivateDir(directory);
  const id = crypto.createHash("sha256").update(`${KEYCHAIN_SERVICE}\0${alias}`).digest("hex");
  return path.join(directory, `${id}.bin`);
}

function dpapiEntropy(alias) {
  return crypto.createHash("sha256").update(`${KEYCHAIN_SERVICE}\0${alias}`).digest("base64");
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--help"], { stdio: "ignore", timeout: 10_000 });
  return !result.error;
}

async function storeSecret(alias, payload) {
  const text = `${JSON.stringify(payload)}\n`;
  if (process.platform === "darwin") {
    runStrict(macHelperPath(), ["set", KEYCHAIN_SERVICE, alias], { input: text });
    return;
  }
  if (process.platform === "win32") {
    const script = [
      "$raw=[Console]::In.ReadToEnd()",
      "$bytes=[Text.Encoding]::UTF8.GetBytes($raw)",
      "$entropy=[Convert]::FromBase64String($env:CODEBUDDYCN_DPAPI_ENTROPY)",
      "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Console]::Out.Write([Convert]::ToBase64String($protected))",
    ].join(";");
    const encrypted = runPowerShell(script, text, dpapiEntropy(alias)).trim();
    writePrivateFileAtomic(windowsSecretPath(alias), `${encrypted}\n`);
    return;
  }
  if (process.platform === "linux") {
    if (!commandAvailable("secret-tool")) throw new AccountError("secret_service_unavailable", "secret-tool is required to use Linux Secret Service");
    runStrict("secret-tool", ["store", `--label=CodeBuddy CN account ${alias}`, "service", KEYCHAIN_SERVICE, "account", alias], { input: text });
    return;
  }
  throw new AccountError("unsupported_platform", `system credential storage is unsupported on ${process.platform}`);
}

async function readSecret(alias) {
  let text;
  if (process.platform === "darwin") {
    text = runStrict(macHelperPath(), ["get", KEYCHAIN_SERVICE, alias]);
  } else if (process.platform === "win32") {
    const filename = windowsSecretPath(alias);
    if (!fs.existsSync(filename)) throw new AccountError("credential_not_found", `credential not found for ${alias}`);
    const script = [
      "$raw=[Console]::In.ReadToEnd().Trim()",
      "$protected=[Convert]::FromBase64String($raw)",
      "$entropy=[Convert]::FromBase64String($env:CODEBUDDYCN_DPAPI_ENTROPY)",
      "$bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
    ].join(";");
    text = runPowerShell(script, fs.readFileSync(filename, "utf8"), dpapiEntropy(alias));
  } else if (process.platform === "linux") {
    if (!commandAvailable("secret-tool")) throw new AccountError("secret_service_unavailable", "secret-tool is required to use Linux Secret Service");
    text = runStrict("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", alias]);
    if (!text) throw new AccountError("credential_not_found", `credential not found for ${alias}`);
  } else {
    throw new AccountError("unsupported_platform", `system credential storage is unsupported on ${process.platform}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AccountError("invalid_stored_credential", `stored credential for ${alias} is invalid`);
  }
  if (parsed?.schema_version !== SCHEMA_VERSION || !parsed?.auth?.accessToken) {
    throw new AccountError("invalid_stored_credential", `stored credential for ${alias} has an unsupported schema`);
  }
  return parsed;
}

async function deleteSecret(alias) {
  if (process.platform === "darwin") {
    runStrict(macHelperPath(), ["delete", KEYCHAIN_SERVICE, alias]);
  } else if (process.platform === "win32") {
    fs.rmSync(windowsSecretPath(alias), { force: true });
  } else if (process.platform === "linux") {
    if (!commandAvailable("secret-tool")) throw new AccountError("secret_service_unavailable", "secret-tool is required to use Linux Secret Service");
    runStrict("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", alias]);
  } else {
    throw new AccountError("unsupported_platform", `system credential storage is unsupported on ${process.platform}`);
  }
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof number === "number" && Number.isFinite(number)) return number;
  }
  return 0;
}

function absoluteMillis(value) {
  const number = finiteNumber(value);
  if (!number) return 0;
  return number < 100_000_000_000 ? number * 1000 : number;
}

const PROFILE_FIELDS = [
  "uid", "nickname", "uin", "type", "lastLogin", "isCreator", "isAdmin",
  "pluginEnabled", "deployStatus", "accountType", "sso", "idp",
  "areaInfoComplete", "oneidAccountId", "isCurrentOneIdEnterprise",
  "isCurrentOneIdPersonal", "isFirstLogin", "phoneNumber", "email",
  "enterpriseId", "enterpriseName", "departmentFullName",
];

function selectedFields(source, fields) {
  const output = {};
  for (const field of fields) {
    if (source[field] !== undefined) output[field] = source[field];
  }
  return output;
}

function normalizeImportedAccount(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new AccountError("invalid_import", `account ${index + 1} is not an object`);
  }
  const rawAuth = objectOrEmpty(item.auth_raw || item.auth);
  const rawProfile = objectOrEmpty(item.profile_raw || item.account);
  const accessToken = nonEmptyString(item.access_token, item.accessToken, item.token, rawAuth.accessToken, rawAuth.access_token);
  const refreshToken = nonEmptyString(item.refresh_token, item.refreshToken, rawAuth.refreshToken, rawAuth.refresh_token);
  if (!accessToken) throw new AccountError("invalid_import", `account ${index + 1} has no access token`);
  if (Buffer.byteLength(accessToken) > 256 * 1024 || Buffer.byteLength(refreshToken) > 256 * 1024) {
    throw new AccountError("invalid_import", `account ${index + 1} contains an oversized token`);
  }

  const uid = nonEmptyString(item.uid, rawProfile.uid, rawProfile.id);
  const email = nonEmptyString(item.email, rawProfile.email);
  const nickname = nonEmptyString(item.nickname, rawProfile.nickname, rawProfile.label);
  const profile = selectedFields(rawProfile, PROFILE_FIELDS);
  if (uid) profile.uid = uid;
  if (email) profile.email = email;
  if (nickname) profile.nickname = nickname;
  const enterpriseId = nonEmptyString(item.enterprise_id, item.enterpriseId, rawProfile.enterpriseId);
  const enterpriseName = nonEmptyString(item.enterprise_name, item.enterpriseName, rawProfile.enterpriseName);
  if (enterpriseId) profile.enterpriseId = enterpriseId;
  if (enterpriseName) profile.enterpriseName = enterpriseName;
  profile.lastLogin = true;
  if (profile.pluginEnabled === undefined) profile.pluginEnabled = true;

  const expiresAt = absoluteMillis(item.expires_at || item.expiresAt || rawAuth.expiresAt);
  const refreshExpiresAt = absoluteMillis(rawAuth.refreshExpiresAt);
  const auth = {
    accessToken,
    refreshToken,
    tokenType: nonEmptyString(item.token_type, item.tokenType, rawAuth.tokenType) || "Bearer",
    domain: nonEmptyString(item.domain, rawAuth.domain),
    expiresAt,
    expiresIn: finiteNumber(rawAuth.expiresIn),
    refreshExpiresAt,
    refreshExpiresIn: finiteNumber(rawAuth.refreshExpiresIn),
    lastRefreshTime: finiteNumber(rawAuth.lastRefreshTime),
    sessionState: nonEmptyString(rawAuth.sessionState),
    scope: nonEmptyString(rawAuth.scope),
  };
  const identity = uid || email.toLowerCase() || nonEmptyString(item.id) || accessToken;
  const fingerprint = crypto.createHash("sha256").update(`codebuddycn\0${identity}`).digest("hex").slice(0, 24);
  return {
    fingerprint,
    label: displayIdentifier(nickname || email || uid || `account-${index + 1}`),
    secret: {
      schema_version: SCHEMA_VERSION,
      account: profile,
      auth,
    },
  };
}

function displayIdentifier(value) {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 160) || "unnamed-account";
}

function allocateAlias(used) {
  for (let number = 1; number <= 9999; number += 1) {
    const alias = `cb${String(number).padStart(2, "0")}`;
    if (!used.has(alias)) return alias;
  }
  throw new AccountError("alias_exhausted", "could not allocate an account alias");
}

export async function importCockpitFile(filename) {
  const absolute = path.resolve(filename);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new AccountError("import_not_found", `import file not found: ${absolute}`);
  }
  if (!stat.isFile()) throw new AccountError("invalid_import", "import path is not a regular file");
  if (stat.size > MAX_IMPORT_BYTES) throw new AccountError("import_too_large", "import file exceeds 50 MiB");
  if (!IS_WIN) fs.chmodSync(absolute, 0o600);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new AccountError("invalid_import", `import JSON is invalid: ${sanitizeDiagnostic(error.message)}`);
  }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : null;
  if (!items?.length) throw new AccountError("invalid_import", "import JSON contains no accounts");
  if (items.length > MAX_ACCOUNTS) throw new AccountError("invalid_import", `import contains more than ${MAX_ACCOUNTS} accounts`);
  const normalized = items.map(normalizeImportedAccount);

  return withIndexLock(async () => {
    const index = loadIndex();
    const byFingerprint = new Map(index.accounts.map((account) => [account.fingerprint, account]));
    const used = new Set(index.accounts.map((account) => account.alias));
    const now = new Date().toISOString();
    let imported = 0;
    let updated = 0;
    const accounts = [];
    for (const item of normalized) {
      let metadata = byFingerprint.get(item.fingerprint);
      if (!metadata) {
        const alias = allocateAlias(used);
        used.add(alias);
        metadata = {
          alias,
          fingerprint: item.fingerprint,
          label: item.label,
          source: "cockpit-workbuddy-export",
          enabled: true,
          created_at: now,
          updated_at: now,
          last_selected_at: null,
          successful_runs: 0,
          failed_runs: 0,
        };
        index.accounts.push(metadata);
        byFingerprint.set(item.fingerprint, metadata);
        imported += 1;
      } else {
        metadata.label = item.label;
        metadata.updated_at = now;
        updated += 1;
      }
      await storeSecret(metadata.alias, item.secret);
      accounts.push({ alias: metadata.alias, label: metadata.label });
    }
    index.accounts.sort((left, right) => left.alias.localeCompare(right.alias, "en", { numeric: true }));
    saveIndex(index);
    return { imported, updated, total: index.accounts.length, accounts };
  });
}

export async function syncLabelsFromCockpitFile(filename) {
  const absolute = path.resolve(filename);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new AccountError("import_not_found", `import file not found: ${absolute}`);
  }
  if (!stat.isFile()) throw new AccountError("invalid_import", "import path is not a regular file");
  if (stat.size > MAX_IMPORT_BYTES) throw new AccountError("import_too_large", "import file exceeds 50 MiB");
  if (!IS_WIN) fs.chmodSync(absolute, 0o600);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new AccountError("invalid_import", `import JSON is invalid: ${sanitizeDiagnostic(error.message)}`);
  }
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : null;
  if (!items?.length) throw new AccountError("invalid_import", "import JSON contains no accounts");
  if (items.length > MAX_ACCOUNTS) throw new AccountError("invalid_import", `import contains more than ${MAX_ACCOUNTS} accounts`);
  const normalized = items.map(normalizeImportedAccount);

  return withIndexLock(async () => {
    const index = loadIndex();
    const byFingerprint = new Map(index.accounts.map((account) => [account.fingerprint, account]));
    const now = new Date().toISOString();
    let updated = 0;
    let unmatched = 0;
    const accounts = [];
    for (const item of normalized) {
      const metadata = byFingerprint.get(item.fingerprint);
      if (!metadata) {
        unmatched += 1;
        continue;
      }
      metadata.label = item.label;
      metadata.updated_at = now;
      updated += 1;
      accounts.push({ alias: metadata.alias, label: metadata.label });
    }
    saveIndex(index);
    return { updated, unmatched, total: index.accounts.length, accounts };
  });
}

export function listAccountMetadata() {
  return loadIndex().accounts.map((account) => ({
    alias: account.alias,
    label: account.label,
    enabled: account.enabled !== false,
    successful_runs: Number(account.successful_runs || 0),
    failed_runs: Number(account.failed_runs || 0),
    last_selected_at: account.last_selected_at || null,
  }));
}

function tokenExpiryAt(data) {
  const explicit = absoluteMillis(data?.expiresAt || data?.expires_at);
  if (explicit) return explicit;
  const duration = finiteNumber(data?.expiresIn, data?.expires_in);
  return duration > 0 ? Date.now() + duration * 1000 : 0;
}

async function refreshSecretIfNeeded(alias, secret) {
  const expiresAt = absoluteMillis(secret.auth.expiresAt);
  if (!expiresAt || expiresAt > Date.now() + REFRESH_EARLY_MS) return { secret, refreshed: false };
  if (!secret.auth.refreshToken) {
    throw new AccountError("refresh_token_missing", `account ${alias} has expired and has no refresh token`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let response;
  try {
    const headers = {
      Authorization: `Bearer ${secret.auth.accessToken}`,
      "X-Refresh-Token": secret.auth.refreshToken,
      "X-Auth-Refresh-Source": "ide-main",
      "User-Agent": "Mozilla/5.0 CodeBuddyCN-Skill/1.0",
    };
    if (secret.auth.domain) headers["X-Domain"] = secret.auth.domain;
    response = await fetch(REFRESH_URL, { method: "POST", headers, signal: controller.signal });
  } catch (error) {
    throw new AccountError("token_refresh_failed", `token refresh failed for ${alias}: ${error.name === "AbortError" ? "timeout" : sanitizeDiagnostic(error.message)}`);
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new AccountError("token_refresh_failed", `token refresh returned invalid JSON for ${alias} (HTTP ${response.status})`);
  }
  const code = Number(body?.code ?? -1);
  if (!response.ok || (code !== 0 && code !== 200)) {
    const message = sanitizeDiagnostic(body?.message || body?.msg || "request rejected");
    throw new AccountError("token_refresh_failed", `token refresh failed for ${alias} (HTTP ${response.status}, code ${code}): ${message}`);
  }
  const data = objectOrEmpty(body.data);
  const accessToken = nonEmptyString(data.accessToken, data.access_token);
  if (!accessToken) throw new AccountError("token_refresh_failed", `token refresh returned no access token for ${alias}`);
  secret.auth.accessToken = accessToken;
  secret.auth.refreshToken = nonEmptyString(data.refreshToken, data.refresh_token) || secret.auth.refreshToken;
  secret.auth.tokenType = nonEmptyString(data.tokenType, data.token_type) || secret.auth.tokenType || "Bearer";
  secret.auth.domain = nonEmptyString(data.domain) || secret.auth.domain;
  secret.auth.expiresAt = tokenExpiryAt(data);
  secret.auth.expiresIn = finiteNumber(data.expiresIn, data.expires_in);
  secret.auth.refreshExpiresAt = absoluteMillis(data.refreshExpiresAt || data.refresh_expires_at) || secret.auth.refreshExpiresAt;
  secret.auth.refreshExpiresIn = finiteNumber(data.refreshExpiresIn, data.refresh_expires_in) || secret.auth.refreshExpiresIn;
  secret.auth.lastRefreshTime = Date.now();
  await storeSecret(alias, secret);
  return { secret, refreshed: true };
}

function selectMetadata(index, requested) {
  const enabled = index.accounts.filter((account) => account.enabled !== false);
  if (!enabled.length) throw new AccountError("no_accounts", "no enabled CodeBuddy CN accounts are stored");
  if (requested === "auto") {
    const cursor = Math.max(0, Number(index.next_cursor || 0));
    const selected = enabled[cursor % enabled.length];
    index.next_cursor = (cursor + 1) % enabled.length;
    return selected;
  }
  const selected = index.accounts.find((account) => account.alias === requested);
  if (!selected) throw new AccountError("account_not_found", `unknown account alias: ${requested}`);
  if (selected.enabled === false) throw new AccountError("account_disabled", `account ${requested} is disabled`);
  return selected;
}

function runtimeHeaders(secret) {
  const headers = [];
  const uid = nonEmptyString(secret.account.uid, secret.account.id);
  const enterpriseId = nonEmptyString(secret.account.enterpriseId);
  if (uid) headers.push(`X-User-Id: ${uid}`);
  if (enterpriseId) {
    headers.push(`X-Enterprise-Id: ${enterpriseId}`);
    headers.push(`X-Tenant-Id: ${enterpriseId}`);
  }
  if (secret.auth.domain) headers.push(`X-Domain: ${secret.auth.domain}`);
  return headers.join("\n");
}

export async function prepareAccountRuntime(requested) {
  if (!requested) return null;
  if (!/^(?:auto|[a-z0-9][a-z0-9._-]{0,63})$/.test(requested)) {
    throw new AccountError("invalid_account_alias", `invalid account alias: ${requested}`);
  }
  return withIndexLock(async () => {
    const index = loadIndex();
    const metadata = selectMetadata(index, requested);
    let secret = await readSecret(metadata.alias);
    const refresh = await refreshSecretIfNeeded(metadata.alias, secret);
    secret = refresh.secret;
    metadata.last_selected_at = new Date().toISOString();
    if (refresh.refreshed) metadata.updated_at = metadata.last_selected_at;
    saveIndex(index);
    const environment = {
      CODEBUDDY_AUTH_TOKEN: secret.auth.accessToken,
      CODEBUDDY_INTERNET_ENVIRONMENT: "internal",
    };
    const headers = runtimeHeaders(secret);
    if (headers) environment.CODEBUDDY_CUSTOM_HEADERS = headers;
    return {
      alias: metadata.alias,
      public: { alias: metadata.alias, label: metadata.label, refreshed: refresh.refreshed },
      sessionUid: nonEmptyString(secret.account.uid, secret.account.id),
      environment,
    };
  });
}

export async function getAccountSessionIdentity(requested) {
  if (!requested || requested === "auto" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(requested)) {
    throw new AccountError("invalid_account_alias", "cross-account resume requires a fixed source account alias");
  }
  return withIndexLock(async () => {
    const index = loadIndex();
    const metadata = selectMetadata(index, requested);
    const secret = await readSecret(metadata.alias);
    const uid = nonEmptyString(secret.account.uid, secret.account.id);
    if (!uid) throw new AccountError("account_uid_missing", `account ${metadata.alias} has no UID for local session transfer`);
    return { alias: metadata.alias, uid };
  });
}

export async function recordAccountRun(alias, success, failureCode = "") {
  if (!alias) return;
  await withIndexLock(async () => {
    const index = loadIndex();
    const metadata = index.accounts.find((account) => account.alias === alias);
    if (!metadata) return;
    if (success) {
      metadata.successful_runs = Number(metadata.successful_runs || 0) + 1;
      metadata.last_success_at = new Date().toISOString();
      metadata.last_failure_code = null;
    } else {
      metadata.failed_runs = Number(metadata.failed_runs || 0) + 1;
      metadata.last_failure_at = new Date().toISOString();
      metadata.last_failure_code = String(failureCode || "codebuddy_failed").slice(0, 80);
    }
    saveIndex(index);
  });
}

export async function verifyAccount(alias) {
  const runtime = await prepareAccountRuntime(alias);
  return runtime.public;
}

export async function removeAccount(alias) {
  return withIndexLock(async () => {
    const index = loadIndex();
    const position = index.accounts.findIndex((account) => account.alias === alias);
    if (position < 0) throw new AccountError("account_not_found", `unknown account alias: ${alias}`);
    await deleteSecret(alias);
    index.accounts.splice(position, 1);
    if (index.accounts.length) index.next_cursor %= index.accounts.length;
    else index.next_cursor = 0;
    saveIndex(index);
    return { removed: alias, total: index.accounts.length };
  });
}

function backendName() {
  if (process.platform === "darwin") return "macOS Keychain";
  if (process.platform === "win32") return "Windows DPAPI";
  if (process.platform === "linux") return "Linux Secret Service";
  return "unsupported";
}

function printHumanList(accounts) {
  if (!accounts.length) {
    process.stdout.write("No stored CodeBuddy CN accounts.\n");
    return;
  }
  for (const account of accounts) {
    const state = account.enabled ? "enabled" : "disabled";
    process.stdout.write(`${account.alias}\t${account.label}\t${state}\tsuccess=${account.successful_runs}\tfail=${account.failed_runs}\n`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (command === "import-cockpit") {
    if (rest.length !== 1) throw new AccountError("invalid_arguments", `import-cockpit requires one JSON file\n${usage()}`);
    const result = await importCockpitFile(rest[0]);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return 0;
  }
  if (command === "sync-labels") {
    if (rest.length !== 1) throw new AccountError("invalid_arguments", `sync-labels requires one JSON file\n${usage()}`);
    const result = await syncLabelsFromCockpitFile(rest[0]);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return 0;
  }
  if (command === "list") {
    const accounts = listAccountMetadata();
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, accounts }, null, 2)}\n`);
    else printHumanList(accounts);
    return 0;
  }
  if (command === "verify") {
    if (rest.length !== 1) throw new AccountError("invalid_arguments", "verify requires an account alias");
    const result = await verifyAccount(rest[0]);
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, account: result }, null, 2)}\n`);
    else process.stdout.write(`${result.alias}\t${result.label}\tcredential=ok\trefreshed=${result.refreshed}\n`);
    return 0;
  }
  if (command === "doctor") {
    let backendReady = false;
    let diagnostic = null;
    try {
      if (process.platform === "darwin") backendReady = Boolean(macHelperPath());
      else if (process.platform === "win32") backendReady = Boolean(powerShellPath());
      else if (process.platform === "linux") backendReady = commandAvailable("secret-tool");
    } catch (error) {
      diagnostic = sanitizeDiagnostic(error.message);
    }
    const result = { ok: backendReady, backend: backendName(), backend_ready: backendReady, account_count: loadIndex().accounts.length, diagnostic };
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`backend=${result.backend}\tready=${result.backend_ready}\taccounts=${result.account_count}${diagnostic ? `\tdiagnostic=${diagnostic}` : ""}\n`);
    return backendReady ? 0 : 1;
  }
  if (command === "remove") {
    if (rest.length !== 2 || rest[1] !== "--yes") throw new AccountError("confirmation_required", "remove requires: remove <alias> --yes");
    const result = await removeAccount(rest[0]);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return 0;
  }
  throw new AccountError("unknown_command", `unknown command: ${command}\n${usage()}`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  }
}

function outputError(error) {
  const message = sanitizeDiagnostic(error?.message || error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error?.code || "unexpected_error", message } })}\n`);
  process.exit(error?.exitCode || 1);
}

if (isMainModule()) {
  main().then((code) => process.exit(code)).catch(outputError);
}
