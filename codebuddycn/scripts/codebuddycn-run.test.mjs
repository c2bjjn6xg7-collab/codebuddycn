import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(scriptDirectory, "codebuddycn-run.mjs");

function makeFakeCli(temp, sessionId = "forked-session-456") {
  const filename = path.join(temp, "fake-codebuddy.mjs");
  fs.writeFileSync(filename, `#!/usr/bin/env node
import fs from "node:fs";
if (process.env.CODEBUDDYCN_TEST_CLI_MARKER) fs.writeFileSync(process.env.CODEBUDDYCN_TEST_CLI_MARKER, "called");
process.stdout.write(JSON.stringify({type:"system",subtype:"init",session_id:${JSON.stringify(sessionId)},model:"mock-model"})+"\\n");
process.stdout.write(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"mock answer"}]}})+"\\n");
process.stdout.write(JSON.stringify({type:"result",subtype:"success",duration_ms:12,num_turns:1,result:"mock answer"})+"\\n");
`, { mode: 0o700 });
  fs.chmodSync(filename, 0o700);
  return filename;
}

function makeFakeSdk(temp, sessionId = "sdk-session-789") {
  const filename = path.join(temp, "fake-agent-sdk.mjs");
  fs.writeFileSync(filename, `import fs from "node:fs";
export function query(params) {
  if (process.env.CODEBUDDYCN_TEST_CAPTURE) {
    const safe = {
      prompt: params.prompt,
      options: {
        pathToCodebuddyCode: params.options.pathToCodebuddyCode,
        cwd: params.options.cwd,
        model: params.options.model,
        tools: params.options.tools,
        allowedTools: params.options.allowedTools,
        disallowedTools: params.options.disallowedTools,
        persistSession: params.options.persistSession,
        maxTurns: params.options.maxTurns,
        settingSources: params.options.settingSources,
        outputFormat: params.options.outputFormat,
        systemPrompt: params.options.systemPrompt,
      },
    };
    fs.writeFileSync(process.env.CODEBUDDYCN_TEST_CAPTURE, JSON.stringify(safe));
  }
  async function* messages() {
    yield {type:"system",subtype:"init",session_id:${JSON.stringify(sessionId)},model:"sdk-mock-model"};
    if (process.env.CODEBUDDYCN_TEST_SDK_ERROR === "quota") {
      yield {type:"result",subtype:"error_during_execution",session_id:${JSON.stringify(sessionId)},is_error:true,errors:["quota exhausted"],errors_info:{category:"quota"}};
      return;
    }
    yield {type:"assistant",session_id:${JSON.stringify(sessionId)},message:{model:"sdk-mock-model",content:[{type:"text",text:"sdk mock answer"}]}};
    yield {type:"result",subtype:"success",session_id:${JSON.stringify(sessionId)},duration_ms:9,num_turns:1,result:"sdk mock answer",usage:{input_tokens:2,output_tokens:3},permission_denials:[]};
  }
  const iterator = messages();
  iterator.interrupt = async () => {};
  return iterator;
}
`, { mode: 0o600 });
  return filename;
}

test("uses the SDK by default and returns its persistent session ID", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddycn-run-test-"));
  try {
    const fakeCli = makeFakeCli(temp);
    const fakeSdk = makeFakeSdk(temp);
    const capture = path.join(temp, "sdk-call.json");
    const result = spawnSync(process.execPath, [
      runner,
      "--persistent",
      "--model", "selected-model",
      "--prompt", "test",
      "--format", "json",
    ], {
      cwd: temp,
      env: {
        ...process.env,
        CODEBUDDYCN_BIN: fakeCli,
        CODEBUDDYCN_SDK_MODULE: fakeSdk,
        CODEBUDDYCN_TEST_CAPTURE: capture,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.backend, "sdk");
    assert.equal(output.via, "codebuddy-agent-sdk-chinese-site");
    assert.equal(output.response.text, "sdk mock answer");
    assert.equal(output.model_used, "sdk-mock-model");
    assert.equal(output.session.id, "sdk-session-789");
    assert.equal(output.session.forked, false);
    const call = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(call.prompt, "test");
    assert.equal(call.options.pathToCodebuddyCode, fakeCli);
    assert.equal(call.options.model, "selected-model");
    assert.deepEqual(call.options.tools, []);
    assert.equal(call.options.persistSession, true);
    assert.deepEqual(call.options.settingSources, ["user"]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("maps context, structured output, and system prompt into SDK options", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddycn-run-test-"));
  try {
    const fakeCli = makeFakeCli(temp);
    const fakeSdk = makeFakeSdk(temp);
    const capture = path.join(temp, "sdk-call.json");
    const context = path.join(temp, "context.txt");
    const schema = path.join(temp, "schema.json");
    const systemPrompt = path.join(temp, "system.txt");
    fs.writeFileSync(context, "selected context");
    fs.writeFileSync(schema, JSON.stringify({ type: "object", properties: { answer: { type: "string" } } }));
    fs.writeFileSync(systemPrompt, "base system prompt");
    const result = spawnSync(process.execPath, [
      runner,
      "--input-file", context,
      "--json-schema-file", schema,
      "--system-prompt-file", systemPrompt,
      "--append-system-prompt", "extra rule",
      "--prompt", "question",
      "--format", "json",
    ], {
      cwd: temp,
      env: {
        ...process.env,
        CODEBUDDYCN_BIN: fakeCli,
        CODEBUDDYCN_SDK_MODULE: fakeSdk,
        CODEBUDDYCN_TEST_CAPTURE: capture,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const call = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.match(call.prompt, /selected context/);
    assert.match(call.prompt, /question$/);
    assert.deepEqual(call.options.tools, ["StructuredOutput"]);
    assert.equal(call.options.outputFormat.type, "json_schema");
    assert.equal(call.options.outputFormat.schema.type, "object");
    assert.equal(call.options.systemPrompt, "base system prompt\n\nextra rule");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("does not replay an SDK quota failure through the CLI backend", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddycn-run-test-"));
  try {
    const fakeCli = makeFakeCli(temp);
    const fakeSdk = makeFakeSdk(temp);
    const marker = path.join(temp, "cli-called");
    const result = spawnSync(process.execPath, [runner, "--prompt", "test", "--format", "json"], {
      cwd: temp,
      env: {
        ...process.env,
        CODEBUDDYCN_BIN: fakeCli,
        CODEBUDDYCN_SDK_MODULE: fakeSdk,
        CODEBUDDYCN_TEST_SDK_ERROR: "quota",
        CODEBUDDYCN_TEST_CLI_MARKER: marker,
      },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).error.code, "quota_exhausted");
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("keeps the legacy CLI as an explicit backend", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddycn-run-test-"));
  try {
    const fakeCli = makeFakeCli(temp);
    const result = spawnSync(process.execPath, [
      runner,
      "--backend", "cli",
      "--persistent",
      "--prompt", "test",
      "--format", "json",
    ], {
      cwd: temp,
      env: { ...process.env, CODEBUDDYCN_BIN: fakeCli },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.backend, "cli");
    assert.equal(output.response.text, "mock answer");
    assert.equal(output.session.id, "forked-session-456");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("cross-account dry-run always adds fork-session without touching credentials", () => {
  const result = spawnSync(process.execPath, [
    runner,
    "--account", "cb02",
    "--resume", "session:test-123",
    "--resume-from-account", "cb01",
    "--prompt", "continue",
    "--format", "json",
    "--dry-run",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.backend, "sdk");
  assert.equal(output.safety.cross_account_resume.source_account, "cb01");
  assert.equal(output.safety.cross_account_resume.target_account, "cb02");
  assert.equal(output.sdk.options.forkSession, true);
  assert.ok(output.cli_fallback.args.includes("--fork-session"));
});

test("cross-account resume rejects formats that cannot verify the fork", () => {
  const result = spawnSync(process.execPath, [
    runner,
    "--account", "cb02",
    "--resume", "session:test-123",
    "--resume-from-account", "cb01",
    "--prompt", "continue",
    "--format", "text",
    "--dry-run",
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --format json/);
});
