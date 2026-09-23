import fs from "node:fs";
import path from "node:path";

// Windows npm shims are batch files. Resolve the package's Node entry instead
// of passing a .cmd file to the SDK or putting prompts through cmd.exe.
export function resolveCliEntrypoint(bin) {
  if (!bin || !/\.(cmd|bat)$/i.test(bin)) return bin;
  const directory = path.dirname(bin);
  const packageRoots = [
    path.join(directory, "node_modules", "@tencent-ai", "codebuddy-code"),
    path.join(directory, "..", "@tencent-ai", "codebuddy-code"),
  ];
  for (const root of packageRoots) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      if (pkg.name !== "@tencent-ai/codebuddy-code") continue;
      const commandName = path.basename(bin).replace(/\.(cmd|bat)$/i, "").toLowerCase();
      const relativeEntry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[commandName] || pkg.bin?.codebuddy;
      if (typeof relativeEntry !== "string") continue;
      const entry = path.resolve(root, relativeEntry);
      if (fs.statSync(entry).isFile()) return entry;
    } catch {}
  }
  const error = new Error("Cannot resolve the CodeBuddy npm shim. Check the @tencent-ai/codebuddy-code installation or set CODEBUDDYCN_BIN to the native codebuddy.exe path.");
  error.code = "cli_entrypoint_not_found";
  throw error;
}

function isNodeScript(filename) {
  if (/\.[cm]?js$/i.test(filename)) return true;
  if (/\.exe$/i.test(filename)) return false;
  let fd;
  try {
    fd = fs.openSync(filename, "r");
    const header = Buffer.alloc(160);
    const count = fs.readSync(fd, header, 0, header.length, 0);
    return /^#![^\r\n]*\bnode(?:\s|$)/.test(header.toString("utf8", 0, count).split(/\r?\n/, 1)[0]);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function cliCommand(bin, args) {
  const entry = resolveCliEntrypoint(bin);
  return isNodeScript(entry)
    ? { command: process.execPath, args: [entry, ...args] }
    : { command: entry, args };
}
