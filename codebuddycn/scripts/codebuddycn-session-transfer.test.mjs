import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  restoreTransferredSession,
  SessionTransferError,
  transferSessionForAccount,
  validateSessionId,
} from "./codebuddycn-session-transfer.mjs";

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function withFixture(callback, { targetNewer = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddycn-transfer-test-"));
  const extensionRoot = path.join(temp, "extension-data");
  const userDataRoot = path.join(temp, "user-data");
  const accountHome = path.join(temp, "skill-data");
  const sourceUid = "source-account";
  const targetUid = "target-account";
  const sessionId = "session-abc_123";
  const workspace = "workspace-hash";
  const ide = "CodeBuddyIDE";
  const sourceAccountRoot = path.join(extensionRoot, sourceUid, ide, sourceUid);
  const targetAccountRoot = path.join(extensionRoot, targetUid, ide, targetUid);
  const sourceWorkspace = path.join(sourceAccountRoot, "history", workspace);
  const targetWorkspace = path.join(targetAccountRoot, "history", workspace);

  writeJson(path.join(sourceWorkspace, "index.json"), {
    conversations: [{ id: sessionId, lastMessageAt: "2026-09-04T10:00:00Z", sourceField: true }],
    current: sessionId,
    sourceTopLevel: true,
  });
  writeJson(path.join(sourceWorkspace, sessionId, "messages", "message.json"), { marker: "source" });
  writeJson(path.join(sourceAccountRoot, "plan-task", workspace, sessionId, "plan.json"), { marker: "plan" });

  writeJson(path.join(targetWorkspace, "index.json"), {
    conversations: [
      { id: "target-only", lastMessageAt: "2026-09-03T10:00:00Z" },
      ...(targetNewer ? [{ id: sessionId, lastMessageAt: "2026-09-05T10:00:00Z" }] : []),
    ],
    current: "target-only",
    targetTopLevel: true,
  });
  if (targetNewer) {
    writeJson(path.join(targetWorkspace, sessionId, "messages", "message.json"), { marker: "target-newer" });
  }

  fs.mkdirSync(userDataRoot, { recursive: true });
  const dbPath = path.join(userDataRoot, "codebuddy-sessions.vscdb");
  const database = new DatabaseSync(dbPath);
  database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
    `session:${sessionId}`,
    JSON.stringify({ conversationId: sessionId, userId: sourceUid, revision: 7 }),
  );
  database.close();

  const previous = {
    accountHome: process.env.CODEBUDDYCN_ACCOUNT_HOME,
    extensionRoot: process.env.CODEBUDDYCN_EXTENSION_DATA_ROOT,
    userDataRoot: process.env.CODEBUDDYCN_USER_DATA_DIR,
  };
  process.env.CODEBUDDYCN_ACCOUNT_HOME = accountHome;
  process.env.CODEBUDDYCN_EXTENSION_DATA_ROOT = extensionRoot;
  process.env.CODEBUDDYCN_USER_DATA_DIR = userDataRoot;

  return Promise.resolve(callback({
    temp,
    extensionRoot,
    userDataRoot,
    accountHome,
    sourceUid,
    targetUid,
    sessionId,
    workspace,
    targetWorkspace,
  })).finally(() => {
    if (previous.accountHome === undefined) delete process.env.CODEBUDDYCN_ACCOUNT_HOME;
    else process.env.CODEBUDDYCN_ACCOUNT_HOME = previous.accountHome;
    if (previous.extensionRoot === undefined) delete process.env.CODEBUDDYCN_EXTENSION_DATA_ROOT;
    else process.env.CODEBUDDYCN_EXTENSION_DATA_ROOT = previous.extensionRoot;
    if (previous.userDataRoot === undefined) delete process.env.CODEBUDDYCN_USER_DATA_DIR;
    else process.env.CODEBUDDYCN_USER_DATA_DIR = previous.userDataRoot;
    fs.rmSync(temp, { recursive: true, force: true });
  });
}

test("copies one session, auxiliary state, and remaps only its database row", { concurrency: false }, async () => {
  await withFixture(async ({ userDataRoot, sourceUid, targetUid, sessionId, targetWorkspace }) => {
    const report = await transferSessionForAccount({ sessionId, sourceUid, targetUid });
    assert.equal(report.workspaces, 1);
    assert.equal(report.added, 1);
    assert.equal(report.replaced, 0);
    assert.equal(report.database_rows, 1);
    assert.ok(fs.statSync(report.backup_dir).isDirectory());

    const index = JSON.parse(fs.readFileSync(path.join(targetWorkspace, "index.json"), "utf8"));
    assert.deepEqual(index.conversations.map((item) => item.id).sort(), [sessionId, "target-only"].sort());
    assert.equal(index.current, sessionId);
    assert.equal(index.targetTopLevel, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(targetWorkspace, sessionId, "messages", "message.json"), "utf8")).marker,
      "source",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(targetWorkspace)), "plan-task", "workspace-hash", sessionId, "plan.json"), "utf8")).marker,
      "plan",
    );

    const database = new DatabaseSync(path.join(userDataRoot, "codebuddy-sessions.vscdb"), { readOnly: true });
    const raw = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get(`session:${sessionId}`).value;
    database.close();
    const row = JSON.parse(String(raw));
    assert.equal(row.userId, targetUid);
    assert.equal(row.revision, 7);
    assert.ok(fs.existsSync(path.join(report.backup_dir, "database", "codebuddy-sessions.vscdb")));

    const restored = await restoreTransferredSession(report);
    assert.equal(restored.restored, true);
    assert.equal(fs.existsSync(path.join(targetWorkspace, sessionId)), false);
    const restoredIndex = JSON.parse(fs.readFileSync(path.join(targetWorkspace, "index.json"), "utf8"));
    assert.deepEqual(restoredIndex.conversations.map((item) => item.id), ["target-only"]);
    assert.equal(restoredIndex.current, "target-only");
    const restoredDatabase = new DatabaseSync(path.join(userDataRoot, "codebuddy-sessions.vscdb"), { readOnly: true });
    const restoredRaw = restoredDatabase.prepare("SELECT value FROM ItemTable WHERE key = ?").get(`session:${sessionId}`).value;
    restoredDatabase.close();
    assert.equal(JSON.parse(String(restoredRaw)).userId, sourceUid);
  });
});

test("is idempotent and keeps a newer target copy", { concurrency: false }, async () => {
  await withFixture(async ({ sourceUid, targetUid, sessionId, targetWorkspace }) => {
    const report = await transferSessionForAccount({ sessionId, sourceUid, targetUid });
    assert.equal(report.added, 0);
    assert.equal(report.replaced, 0);
    assert.equal(report.kept_newer, 1);
    const marker = JSON.parse(fs.readFileSync(path.join(targetWorkspace, sessionId, "messages", "message.json"), "utf8"));
    assert.equal(marker.marker, "target-newer");
    await restoreTransferredSession(report);
    const restoredMarker = JSON.parse(fs.readFileSync(path.join(targetWorkspace, sessionId, "messages", "message.json"), "utf8"));
    assert.equal(restoredMarker.marker, "target-newer");
  }, { targetNewer: true });
});

test("restoration preserves a fork created by the target account", { concurrency: false }, async () => {
  await withFixture(async ({ userDataRoot, sourceUid, targetUid, sessionId, targetWorkspace }) => {
    const report = await transferSessionForAccount({ sessionId, sourceUid, targetUid });
    const forkedId = "forked-session-456";
    const indexPath = path.join(targetWorkspace, "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.conversations.push({ id: forkedId, lastMessageAt: "2026-09-04T11:00:00Z" });
    index.current = forkedId;
    writeJson(indexPath, index);
    writeJson(path.join(targetWorkspace, forkedId, "messages", "message.json"), { marker: "forked" });

    const database = new DatabaseSync(path.join(userDataRoot, "codebuddy-sessions.vscdb"));
    database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      `session:${forkedId}`,
      JSON.stringify({ conversationId: forkedId, userId: targetUid, revision: 1 }),
    );
    database.close();

    await restoreTransferredSession(report);
    const restoredIndex = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    assert.deepEqual(restoredIndex.conversations.map((item) => item.id).sort(), [forkedId, "target-only"].sort());
    assert.equal(restoredIndex.current, forkedId);
    assert.equal(fs.existsSync(path.join(targetWorkspace, sessionId)), false);
    assert.equal(fs.existsSync(path.join(targetWorkspace, forkedId)), true);

    const restoredDatabase = new DatabaseSync(path.join(userDataRoot, "codebuddy-sessions.vscdb"), { readOnly: true });
    const parent = JSON.parse(String(restoredDatabase.prepare("SELECT value FROM ItemTable WHERE key = ?").get(`session:${sessionId}`).value));
    const fork = JSON.parse(String(restoredDatabase.prepare("SELECT value FROM ItemTable WHERE key = ?").get(`session:${forkedId}`).value));
    restoredDatabase.close();
    assert.equal(parent.userId, sourceUid);
    assert.equal(fork.userId, targetUid);
  });
});

test("rejects a mismatched database owner and rolls back staged files", { concurrency: false }, async () => {
  await withFixture(async ({ userDataRoot, sourceUid, targetUid, sessionId, targetWorkspace }) => {
    const database = new DatabaseSync(path.join(userDataRoot, "codebuddy-sessions.vscdb"));
    database.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(
      JSON.stringify({ conversationId: sessionId, userId: "different-account", revision: 7 }),
      `session:${sessionId}`,
    );
    database.close();

    await assert.rejects(
      transferSessionForAccount({ sessionId, sourceUid, targetUid }),
      (error) => error instanceof SessionTransferError && error.code === "session_source_mismatch",
    );
    const index = JSON.parse(fs.readFileSync(path.join(targetWorkspace, "index.json"), "utf8"));
    assert.deepEqual(index.conversations.map((item) => item.id), ["target-only"]);
    assert.equal(fs.existsSync(path.join(targetWorkspace, sessionId)), false);
  });
});

test("rejects symlinked target storage components", { concurrency: false }, async () => {
  await withFixture(async ({ temp, extensionRoot, sourceUid, targetUid, sessionId, targetWorkspace }) => {
    const historyRoot = path.dirname(targetWorkspace);
    fs.rmSync(historyRoot, { recursive: true, force: true });
    const outside = path.join(temp, "outside-history");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, historyRoot, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      transferSessionForAccount({ sessionId, sourceUid, targetUid }),
      (error) => error instanceof SessionTransferError && error.code === "unsafe_session_path",
    );
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(fs.existsSync(path.join(extensionRoot, sourceUid)));
  });
});

test("rejects unsafe session identifiers before touching storage", () => {
  for (const value of ["", "../session", "session/path", " session", "session.json"]) {
    assert.throws(() => validateSessionId(value), SessionTransferError);
  }
  assert.equal(validateSessionId("session:abc-123_DEF"), "session:abc-123_DEF");
});
