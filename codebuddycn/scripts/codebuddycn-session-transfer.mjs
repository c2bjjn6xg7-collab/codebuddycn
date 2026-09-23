import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/;
const AUXILIARY_KINDS = ["check-point", "file-tree", "plan-task", "genie-cache", "connectors"];

export class SessionTransferError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function privateDataRoot() {
  if (process.env.CODEBUDDYCN_ACCOUNT_HOME) return path.resolve(process.env.CODEBUDDYCN_ACCOUNT_HOME);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "codebuddycn-skill");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "codebuddycn-skill");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "codebuddycn-skill");
}

function extensionDataRoot() {
  if (process.env.CODEBUDDYCN_EXTENSION_DATA_ROOT) {
    return path.resolve(process.env.CODEBUDDYCN_EXTENSION_DATA_ROOT);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodeBuddyExtension", "Data");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "CodeBuddyExtension", "Data");
}

function codebuddyUserDataRoot() {
  if (process.env.CODEBUDDYCN_USER_DATA_DIR) {
    return path.resolve(process.env.CODEBUDDYCN_USER_DATA_DIR);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "CodeBuddy CN");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "CodeBuddy CN");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "CodeBuddy CN");
}

function ensurePrivateDirectory(directory) {
  const existing = assertNotSymlink(directory);
  if (existing && !existing.isDirectory()) {
    throw new SessionTransferError("unsafe_session_path", "private CodeBuddy session directory is not a directory");
  }
  if (!existing) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function validateIdentity(value, label) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new SessionTransferError("invalid_session_identity", `${label} is missing or contains surrounding whitespace`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..") || value.includes("\0")) {
    throw new SessionTransferError("invalid_session_identity", `${label} contains unsafe path characters`);
  }
  if (path.basename(value) !== value) {
    throw new SessionTransferError("invalid_session_identity", `${label} is not a single safe path component`);
  }
  return value;
}

export function validateSessionId(sessionId) {
  if (!SESSION_ID_PATTERN.test(String(sessionId || ""))) {
    throw new SessionTransferError(
      "invalid_session_id",
      "session ID must start with a letter or number and contain only letters, numbers, hyphens, underscores, or colons",
    );
  }
  return sessionId;
}

function assertNotSymlink(filename) {
  try {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) {
      throw new SessionTransferError("unsafe_session_path", "refusing to read or write a symlink in CodeBuddy session storage");
    }
    return stat;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new SessionTransferError("unsafe_session_path", "resolved CodeBuddy session path escapes its expected root");
}

function assertNoSymlinkComponents(root, candidate) {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  assertInside(absoluteRoot, absoluteCandidate);
  let current = absoluteRoot;
  const rootStat = assertNotSymlink(current);
  if (rootStat && !rootStat.isDirectory()) {
    throw new SessionTransferError("unsafe_session_path", "CodeBuddy session root is not a directory");
  }
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = assertNotSymlink(current);
    if (!stat) break;
  }
}

function readJsonObject(filename) {
  const stat = assertNotSymlink(filename);
  if (!stat?.isFile()) throw new SessionTransferError("invalid_session_index", "CodeBuddy session index is missing or not a regular file");
  if (stat.size > MAX_INDEX_BYTES) throw new SessionTransferError("session_index_too_large", "CodeBuddy session index exceeds 64 MiB");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    throw new SessionTransferError("invalid_session_index", "CodeBuddy session index is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SessionTransferError("invalid_session_index", "CodeBuddy session index is not an object");
  }
  return parsed;
}

function writeJsonAtomic(filename, value) {
  const parent = path.dirname(filename);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(filename)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function copyPathSecure(source, target) {
  const stat = assertNotSymlink(source);
  if (!stat) throw new SessionTransferError("session_source_missing", "CodeBuddy session source disappeared during transfer");
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true, mode: stat.mode & 0o777 });
    for (const entry of fs.readdirSync(source)) copyPathSecure(path.join(source, entry), path.join(target, entry));
    return;
  }
  if (!stat.isFile()) throw new SessionTransferError("unsafe_session_path", "unsupported file type in CodeBuddy session storage");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

function backupPath(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  copyPathSecure(source, target);
  return true;
}

function replaceDirectoryAtomic(source, target) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const suffix = `${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const temporary = path.join(parent, `.codebuddycn-session-new.${suffix}`);
  const previous = path.join(parent, `.codebuddycn-session-old.${suffix}`);
  copyPathSecure(source, temporary);
  let movedPrevious = false;
  try {
    if (fs.existsSync(target)) {
      assertNotSymlink(target);
      fs.renameSync(target, previous);
      movedPrevious = true;
    }
    fs.renameSync(temporary, target);
    if (movedPrevious) fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    if (movedPrevious && !fs.existsSync(target) && fs.existsSync(previous)) fs.renameSync(previous, target);
    throw error;
  }
}

function conversationTimestamp(value) {
  const raw = value?.lastMessageAt ?? value?.updatedAt ?? value?.createdAt;
  if (Number.isFinite(raw)) return Number(raw);
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function conversationId(value) {
  return value && typeof value === "object" && typeof value.id === "string" ? value.id : "";
}

function operationId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

function pruneBackups(keep = 5) {
  const root = path.join(privateDataRoot(), "session-backups");
  const rootStat = assertNotSymlink(root);
  if (!rootStat?.isDirectory()) return;
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => {
      const pathname = path.join(root, entry.name);
      return { pathname, mtime: fs.statSync(pathname).mtimeMs };
    })
    .sort((left, right) => right.mtime - left.mtime);
  for (const entry of entries.slice(Math.max(1, keep))) {
    assertInside(root, entry.pathname);
    fs.rmSync(entry.pathname, { recursive: true, force: true });
  }
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

async function acquireTransferLock() {
  const lockRoot = path.join(privateDataRoot(), "session-transfer");
  ensurePrivateDirectory(lockRoot);
  const lockPath = path.join(lockRoot, ".lock");
  const deadline = Date.now() + 15_000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: Date.now() }), "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (!processExists(Number(lock.pid)) || Date.now() - Number(lock.created_at || 0) > 24 * 60 * 60 * 1000) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > 24 * 60 * 60 * 1000) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch {}
      }
      if (Date.now() >= deadline) {
        throw new SessionTransferError("session_transfer_busy", "another CodeBuddy session transfer is still running");
      }
      await delay(75);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(lockPath, { force: true }); } catch {}
  };
}

function sourceMatches(root, sourceUid, sessionId) {
  const matches = [];
  const sourceOuter = path.join(root, sourceUid);
  const outerStat = assertNotSymlink(sourceOuter);
  if (!outerStat?.isDirectory()) return matches;
  for (const ideEntry of fs.readdirSync(sourceOuter, { withFileTypes: true })) {
    if (!ideEntry.isDirectory() || ideEntry.isSymbolicLink()) continue;
    const ideName = ideEntry.name;
    const sourceAccountRoot = path.join(sourceOuter, ideName, sourceUid);
    const historyRoot = path.join(sourceAccountRoot, "history");
    assertNoSymlinkComponents(sourceOuter, historyRoot);
    const historyStat = assertNotSymlink(historyRoot);
    if (!historyStat?.isDirectory()) continue;
    for (const workspaceEntry of fs.readdirSync(historyRoot, { withFileTypes: true })) {
      if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) continue;
      const workspaceName = workspaceEntry.name;
      const sourceWorkspace = path.join(historyRoot, workspaceName);
      assertNoSymlinkComponents(sourceOuter, sourceWorkspace);
      const sourceIndexPath = path.join(sourceWorkspace, "index.json");
      if (!fs.existsSync(sourceIndexPath)) continue;
      const sourceIndex = readJsonObject(sourceIndexPath);
      const conversations = Array.isArray(sourceIndex.conversations) ? sourceIndex.conversations : [];
      const conversation = conversations.find((item) => conversationId(item) === sessionId);
      if (!conversation) continue;
      const sourceConversation = path.join(sourceWorkspace, sessionId);
      const conversationStat = assertNotSymlink(sourceConversation);
      if (!conversationStat?.isDirectory()) {
        throw new SessionTransferError("session_body_missing", "CodeBuddy session metadata exists but its local conversation body is missing");
      }
      matches.push({ ideName, workspaceName, sourceAccountRoot, sourceWorkspace, sourceIndex, conversation });
    }
  }
  return matches;
}

function transferWorkspace({ root, sourceUid, targetUid, sessionId, match, backupRoot, restoreEntries }) {
  const { ideName, workspaceName, sourceAccountRoot, sourceWorkspace, sourceIndex, conversation } = match;
  const targetAccountRoot = path.join(root, targetUid, ideName, targetUid);
  const targetWorkspace = path.join(targetAccountRoot, "history", workspaceName);
  assertNoSymlinkComponents(path.join(root, targetUid), targetWorkspace);

  const targetIndexPath = path.join(targetWorkspace, "index.json");
  const targetIndexExisted = fs.existsSync(targetIndexPath);
  let targetIndex;
  if (targetIndexExisted) {
    targetIndex = readJsonObject(targetIndexPath);
  } else {
    targetIndex = { ...sourceIndex, conversations: [] };
  }
  const targetConversations = Array.isArray(targetIndex.conversations) ? [...targetIndex.conversations] : [];
  const existingIndex = targetConversations.findIndex((item) => conversationId(item) === sessionId);
  const originalConversation = existingIndex >= 0 ? structuredClone(targetConversations[existingIndex]) : null;
  const originalCurrent = targetIndex.current;
  const sourceConversation = path.join(sourceWorkspace, sessionId);
  const targetConversation = path.join(targetWorkspace, sessionId);
  const targetConversationExisted = fs.existsSync(targetConversation);
  let added = 0;
  let replaced = 0;
  let keptNewer = 0;
  let copyBody = false;

  if (existingIndex < 0) {
    targetConversations.push(conversation);
    added = 1;
    copyBody = true;
  } else if (!fs.existsSync(targetConversation) || conversationTimestamp(conversation) > conversationTimestamp(targetConversations[existingIndex])) {
    targetConversations[existingIndex] = conversation;
    replaced = 1;
    copyBody = true;
  } else {
    keptNewer = 1;
  }

  fs.mkdirSync(targetWorkspace, { recursive: true });
  const workspaceBackup = path.join(backupRoot, "history", ideName, workspaceName);
  if (fs.existsSync(targetIndexPath)) backupPath(targetIndexPath, path.join(workspaceBackup, "index.json"));
  const restoreEntry = {
    targetIndexPath,
    targetIndexExisted,
    originalConversation,
    originalCurrent,
    targetConversation,
    targetConversationExisted,
    targetConversationBackup: path.join(workspaceBackup, "conversations", sessionId),
    copiedBody: copyBody,
    auxiliaries: [],
  };
  restoreEntries.push(restoreEntry);
  if (copyBody) {
    if (fs.existsSync(targetConversation)) {
      backupPath(targetConversation, restoreEntry.targetConversationBackup);
    }
    replaceDirectoryAtomic(sourceConversation, targetConversation);
  }

  targetConversations.sort((left, right) => conversationTimestamp(right) - conversationTimestamp(left));
  targetIndex.conversations = targetConversations;
  targetIndex.current = sessionId;
  writeJsonAtomic(targetIndexPath, targetIndex);

  for (const kind of AUXILIARY_KINDS) {
    const sourceAux = path.join(sourceAccountRoot, kind, workspaceName, sessionId);
    const sourceAuxStat = assertNotSymlink(sourceAux);
    if (!sourceAuxStat?.isDirectory()) continue;
    const targetAux = path.join(targetAccountRoot, kind, workspaceName, sessionId);
    assertNoSymlinkComponents(path.join(root, targetUid), targetAux);
    const targetAuxExisted = fs.existsSync(targetAux);
    const targetAuxBackup = path.join(backupRoot, "auxiliary", ideName, workspaceName, kind, sessionId);
    const replaceAux = copyBody || !targetAuxExisted;
    restoreEntry.auxiliaries.push({ target: targetAux, existed: targetAuxExisted, backup: targetAuxBackup, replaced: replaceAux });
    if (targetAuxExisted && replaceAux) backupPath(targetAux, targetAuxBackup);
    if (replaceAux) replaceDirectoryAtomic(sourceAux, targetAux);
  }

  return { added, replaced, keptNewer };
}

function parseDatabaseRows(rows, sessionId, sourceUid) {
  const updates = [];
  let sessionRows = 0;
  for (const row of rows) {
    let value;
    try {
      value = JSON.parse(typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8"));
    } catch {
      continue;
    }
    if (value?.conversationId !== sessionId) continue;
    sessionRows += 1;
    if (value?.userId !== sourceUid) continue;
    const originalValue = typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
    updates.push({ key: String(row.key), originalValue, value });
  }
  return { updates, sessionRows };
}

async function remapSessionDatabase(dbPath, sessionId, sourceUid, targetUid, backupRoot) {
  const stat = assertNotSymlink(dbPath);
  if (!stat) throw new SessionTransferError("session_database_not_found", "CodeBuddy session database was not found");
  if (!stat.isFile()) throw new SessionTransferError("invalid_session_database", "CodeBuddy session database is not a regular file");

  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    sqlite = null;
  }

  if (sqlite?.DatabaseSync) {
    const database = new sqlite.DatabaseSync(dbPath);
    try {
      database.exec("PRAGMA busy_timeout=5000");
      const rows = database.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'session:%'").all();
      const inspected = parseDatabaseRows(rows, sessionId, sourceUid);
      if (!inspected.updates.length) {
        throw new SessionTransferError(
          inspected.sessionRows ? "session_source_mismatch" : "session_database_entry_missing",
          inspected.sessionRows
            ? "the CodeBuddy session database is owned by a different source account"
            : "the requested CodeBuddy session is absent from the local session database",
        );
      }
      const updates = inspected.updates;
      ensurePrivateDirectory(backupRoot);
      fs.copyFileSync(dbPath, path.join(backupRoot, "codebuddy-sessions.vscdb"));
      database.exec("BEGIN IMMEDIATE");
      try {
        const statement = database.prepare("UPDATE ItemTable SET value = ? WHERE key = ?");
        for (const update of updates) {
          update.value.userId = targetUid;
          statement.run(JSON.stringify(update.value), update.key);
        }
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
      return updates;
    } finally {
      database.close();
    }
  }

  const query = spawnSync("sqlite3", ["-readonly", "-json", dbPath, "SELECT key, value FROM ItemTable WHERE key LIKE 'session:%'"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (query.error?.code === "ENOENT") {
    throw new SessionTransferError("sqlite_unavailable", "cross-account resume requires Node.js 22+ or the sqlite3 command");
  }
  if (query.status !== 0) throw new SessionTransferError("session_database_failed", "could not read the CodeBuddy session database");
  let rows;
  try {
    rows = JSON.parse(query.stdout || "[]");
  } catch {
    throw new SessionTransferError("session_database_failed", "sqlite3 returned invalid JSON for the CodeBuddy session database");
  }
  const inspected = parseDatabaseRows(rows, sessionId, sourceUid);
  if (!inspected.updates.length) {
    throw new SessionTransferError(
      inspected.sessionRows ? "session_source_mismatch" : "session_database_entry_missing",
      inspected.sessionRows
        ? "the CodeBuddy session database is owned by a different source account"
        : "the requested CodeBuddy session is absent from the local session database",
    );
  }
  const updates = inspected.updates;
  ensurePrivateDirectory(backupRoot);
  fs.copyFileSync(dbPath, path.join(backupRoot, "codebuddy-sessions.vscdb"));
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const statements = updates.map((update) => {
    update.value.userId = targetUid;
    return `UPDATE ItemTable SET value = ${quote(JSON.stringify(update.value))} WHERE key = ${quote(update.key)};`;
  });
  const write = spawnSync("sqlite3", [dbPath], {
    input: `PRAGMA busy_timeout=5000;\nBEGIN IMMEDIATE;\n${statements.join("\n")}\nCOMMIT;\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (write.status !== 0) throw new SessionTransferError("session_database_failed", "could not update the CodeBuddy session database");
  return updates;
}

function restoreDirectory(entryPath, existed, backup) {
  if (existed) {
    if (!fs.existsSync(backup)) {
      throw new SessionTransferError("session_backup_missing", "a required CodeBuddy session backup is missing");
    }
    replaceDirectoryAtomic(backup, entryPath);
  } else if (fs.existsSync(entryPath)) {
    assertNotSymlink(entryPath);
    fs.rmSync(entryPath, { recursive: true, force: true });
  }
}

function restoreWorkspaceEntry(entry, sessionId) {
  if (entry.copiedBody) {
    restoreDirectory(entry.targetConversation, entry.targetConversationExisted, entry.targetConversationBackup);
  }
  for (const auxiliary of entry.auxiliaries) {
    if (auxiliary.replaced) restoreDirectory(auxiliary.target, auxiliary.existed, auxiliary.backup);
  }

  if (!fs.existsSync(entry.targetIndexPath)) return;
  const index = readJsonObject(entry.targetIndexPath);
  const conversations = Array.isArray(index.conversations) ? index.conversations : [];
  const filtered = conversations.filter((item) => conversationId(item) !== sessionId);
  if (entry.originalConversation) filtered.push(entry.originalConversation);
  filtered.sort((left, right) => conversationTimestamp(right) - conversationTimestamp(left));
  index.conversations = filtered;
  if (index.current === sessionId) {
    if (entry.originalCurrent === undefined) delete index.current;
    else index.current = entry.originalCurrent;
  }
  if (!entry.targetIndexExisted && filtered.length === 0) {
    fs.rmSync(entry.targetIndexPath, { force: true });
    return;
  }
  writeJsonAtomic(entry.targetIndexPath, index);
}

async function restoreDatabaseRows(dbPath, rows) {
  if (!rows.length || !fs.existsSync(dbPath)) return 0;
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    sqlite = null;
  }
  if (sqlite?.DatabaseSync) {
    const database = new sqlite.DatabaseSync(dbPath);
    try {
      database.exec("PRAGMA busy_timeout=5000");
      database.exec("BEGIN IMMEDIATE");
      try {
        const statement = database.prepare("UPDATE ItemTable SET value = ? WHERE key = ?");
        for (const row of rows) statement.run(row.originalValue, row.key);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
      }
    } finally {
      database.close();
    }
    return rows.length;
  }
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const statements = rows.map((row) => `UPDATE ItemTable SET value = ${quote(row.originalValue)} WHERE key = ${quote(row.key)};`);
  const write = spawnSync("sqlite3", [dbPath], {
    input: `PRAGMA busy_timeout=5000;\nBEGIN IMMEDIATE;\n${statements.join("\n")}\nCOMMIT;\n`,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (write.status !== 0) throw new SessionTransferError("session_database_restore_failed", "could not restore the original CodeBuddy session database row");
  return rows.length;
}

export async function restoreTransferredSession(report) {
  const restore = report?._restore;
  if (!restore) return { restored: false, database_rows: 0, workspaces: 0 };
  if (restore.promise) return restore.promise;
  restore.promise = (async () => {
  const errors = [];
  let databaseRows = 0;
  let workspaceCount = 0;
  try {
    try {
      databaseRows = await restoreDatabaseRows(restore.dbPath, restore.databaseRows);
    } catch (error) {
      errors.push(error);
    }
    for (const entry of [...restore.workspaces].reverse()) {
      try {
        restoreWorkspaceEntry(entry, report.session_id);
        workspaceCount += 1;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new SessionTransferError(
        "session_restore_failed",
        `could not completely restore staged CodeBuddy session data; backup retained at ${report.backup_dir}`,
      );
    }
    pruneBackups(5);
    return { restored: true, database_rows: databaseRows, workspaces: workspaceCount };
  } finally {
    restore.release?.();
    restore.release = null;
  }
  })();
  return restore.promise;
}

export async function transferSessionForAccount({ sessionId, sourceUid, targetUid }) {
  validateSessionId(sessionId);
  validateIdentity(sourceUid, "source account UID");
  validateIdentity(targetUid, "target account UID");
  if (sourceUid === targetUid) {
    throw new SessionTransferError("same_session_account", "source and target CodeBuddy accounts are the same");
  }

  const release = await acquireTransferLock();
  const restore = {
    release,
    workspaces: [],
    dbPath: path.join(codebuddyUserDataRoot(), "codebuddy-sessions.vscdb"),
    databaseRows: [],
  };
  let report = null;
  try {
    const root = extensionDataRoot();
    const rootStat = assertNotSymlink(root);
    if (!rootStat?.isDirectory()) {
      throw new SessionTransferError("session_storage_not_found", "CodeBuddy local session storage was not found");
    }
    const matches = sourceMatches(root, sourceUid, sessionId);
    if (!matches.length) {
      throw new SessionTransferError("session_not_found_for_source", "the requested session was not found under the source CodeBuddy account");
    }

    const backupRoot = path.join(privateDataRoot(), "session-backups", operationId());
    ensurePrivateDirectory(backupRoot);
    report = {
      session_id: sessionId,
      workspaces: 0,
      added: 0,
      replaced: 0,
      kept_newer: 0,
      database_rows: 0,
      backup_dir: backupRoot,
    };
    Object.defineProperty(report, "_restore", { value: restore, enumerable: false });
    for (const match of matches) {
      const result = transferWorkspace({
        root,
        sourceUid,
        targetUid,
        sessionId,
        match,
        backupRoot,
        restoreEntries: restore.workspaces,
      });
      report.workspaces += 1;
      report.added += result.added;
      report.replaced += result.replaced;
      report.kept_newer += result.keptNewer;
    }
    restore.databaseRows = await remapSessionDatabase(
      restore.dbPath,
      sessionId,
      sourceUid,
      targetUid,
      path.join(backupRoot, "database"),
    );
    report.database_rows = restore.databaseRows.length;
    return report;
  } catch (error) {
    if (report) {
      try {
        await restoreTransferredSession(report);
      } catch (restoreError) {
        throw new SessionTransferError(
          "session_restore_failed",
          `cross-account session staging failed and rollback was incomplete; backup retained at ${report.backup_dir}`,
        );
      }
    } else {
      release();
    }
    throw error;
  }
}
