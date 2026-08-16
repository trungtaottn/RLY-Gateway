#!/usr/bin/env node
// Generates dist/rly-build.json — the exact build identity (#94) embedded in
// the built tree so /identity, `rly --version`, diagnostics, deployment
// metadata, and update probation all read the SAME build identity. Runs as a
// prebuild step; missing git metadata (release tarballs) falls back to
// explicit unknown markers rather than failing the build.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

const commitRevision = git(["rev-parse", "HEAD"]) ?? "unknown";
const tree = git(["rev-parse", "HEAD^{tree}"]) ?? "unknown";
const releaseChannel = process.env.RLY_RELEASE_CHANNEL ?? "dev";
// Build ID distinguishes rebuilds of the same commit/channel.
const buildId = createHash("sha256")
  .update([commitRevision, tree, releaseChannel, new Date().toISOString()].join("|"))
  .digest("hex")
  .slice(0, 16);

const meta = {
  semanticVersion: packageJson.version,
  commitRevision,
  buildId,
  releaseChannel,
  controlProtocolVersion: 1,
  dataProtocolVersion: 1,
  stateSchemaVersion: 2,
};

await mkdir(join(root, "dist"), { recursive: true });
await writeFile(join(root, "dist", "rly-build.json"), `${JSON.stringify(meta, null, 2)}\n`);
