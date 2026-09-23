import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cliCommand, resolveCliEntrypoint } from "./codebuddycn-cli.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));

function npmFixture(t, { local = false, alias = "codebuddy.cmd" } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddycn-npm-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const prefix = path.join(temp, "用户目录 & spaces");
  const root = path.join(prefix, "node_modules", "@tencent-ai", "codebuddy-code");
  const shim = path.join(prefix, ...(local ? ["node_modules", ".bin"] : []), alias);
  const entry = path.join(root, "bin", "codebuddy");
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(shim, "@echo off\r\nexit /b 99\r\n", { mode: 0o700 });
  fs.chmodSync(shim, 0o700);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "@tencent-ai/codebuddy-code",
    bin: { codebuddy: "bin/codebuddy", cbc: "bin/codebuddy" },
  }));
  fs.writeFileSync(entry, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--echo-args')) console.log(JSON.stringify(args.slice(1)));
else if (args.includes('--version')) console.log('1.2.3-fixture');
else if (args.includes('--help')) console.log('--print --output-format --model --tools --setting-sources --no-session-persistence');
else {
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session'}));
  console.log(JSON.stringify({type:'result',subtype:'success',result:'fixture answer'}));
}
`, { mode: 0o600 });
  return { temp, root, shim, entry };
}

test("launches a Windows npm shim through Node and preserves literal arguments", (t) => {
  const { shim, entry } = npmFixture(t);
  const args = ['中文 prompt', 'a "quoted" value', '& echo unexpected', '%PATH%', '$HOME', 'line one\nline two'];
  const launch = cliCommand(shim, ['--echo-args', ...args]);
  assert.equal(resolveCliEntrypoint(shim), entry);
  const result = spawnSync(launch.command, launch.args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("finds the package beside a local .bin alias", (t) => {
  const { shim, entry } = npmFixture(t, { local: true, alias: "cbc.CMD" });
  assert.equal(resolveCliEntrypoint(shim), entry);
});

test("preflight reads version and capabilities through the npm shim", (t) => {
  const { temp, shim, entry } = npmFixture(t);
  const result = spawnSync(process.execPath, [path.join(scripts, "preflight.mjs"), "--json"], {
    env: { ...process.env, CODEBUDDYCN_BIN: shim, CODEBUDDYCN_ACCOUNT_HOME: path.join(temp, "accounts") },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  const report = JSON.parse(result.stdout);
  assert.equal(report.codebuddy.bin, entry);
  assert.equal(report.codebuddy.version, "1.2.3-fixture");
  assert.equal(report.codebuddy.headless_ready, true);
});

test("both SDK and explicit CLI calls use the resolved npm entry", (t) => {
  const { temp, shim, entry } = npmFixture(t);
  const sdk = path.join(temp, "fake-sdk.mjs");
  const capture = path.join(temp, "sdk-entry.txt");
  fs.writeFileSync(sdk, `import fs from 'node:fs';
export async function* query({options}) {
  fs.writeFileSync(process.env.CODEBUDDYCN_TEST_CAPTURE, options.pathToCodebuddyCode);
  yield {type:'result',subtype:'success',result:'fixture answer'};
}
`);
  for (const backend of ["sdk", "cli"]) {
    const result = spawnSync(process.execPath, [
      path.join(scripts, "codebuddycn-run.mjs"),
      "--backend", backend, "--prompt", "fixture prompt", "--format", "json",
    ], {
      cwd: temp,
      env: {
        ...process.env,
        CODEBUDDYCN_BIN: shim,
        CODEBUDDYCN_SDK_MODULE: sdk,
        CODEBUDDYCN_TEST_CAPTURE: capture,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).response.text, "fixture answer");
  }
  assert.equal(fs.readFileSync(capture, "utf8"), entry);
});

test("reports a broken npm installation instead of executing its batch file", (t) => {
  const { shim, entry } = npmFixture(t);
  fs.rmSync(entry);
  assert.throws(() => resolveCliEntrypoint(shim), { code: "cli_entrypoint_not_found" });
});

test("keeps native exe commands unchanged", () => {
  const exe = path.join(os.tmpdir(), "native cli", "codebuddy.exe");
  assert.deepEqual(cliCommand(exe, ["--version"]), { command: exe, args: ["--version"] });
});
