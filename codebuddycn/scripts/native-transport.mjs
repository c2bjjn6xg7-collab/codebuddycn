#!/usr/bin/env node
// Native transport adapter: forwards SDK argv/stdio/env verbatim to the
// verified native CodeBuddy CLI. SDK 0.3.256 spawns pathToCodebuddyCode via
// Node and rewrites */bin/codebuddy to dist/codebuddy-headless.js, which does
// not exist in the Mach-O native install; this .mjs entry sidesteps that.
// Native binary path is supplied per-task via CODEBUDDYCN_NATIVE_BIN.
import { spawn } from 'node:child_process';

const nativePath = process.env.CODEBUDDYCN_NATIVE_BIN;
if (!nativePath) {
  process.stderr.write('Set CODEBUDDYCN_NATIVE_BIN to the verified native CLI path\n');
  process.exit(1);
}
const child = spawn(nativePath, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => {
  process.stderr.write('native CodeBuddy transport startup failed\n');
  process.exitCode = 1;
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
