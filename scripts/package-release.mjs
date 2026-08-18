#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const forbidden = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)gateway\.config\.toml$/,
  /\.sqlite$/,
  /(^|\/)plans\//,
  /(^|\/)\.rly\//,
  /(^|\/)\.agent-gateway\//,
  /(^|\/)control-plane\.sqlite/,
];

const files = [
  ...execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }).trim().split("\n").filter(Boolean),
];
const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (leaked.length > 0) {
  process.stderr.write(`Package inventory includes private paths:\n${leaked.join("\n")}\n`);
  process.exit(1);
}

const directory = await mkdtemp(join(tmpdir(), "rly-gateway-package-"));
try {
  const archive = join(directory, "snapshot.tar");
  execFileSync("tar", ["-cf", archive, "-T", "-"], { input: `${files.join("\n")}\n` });
  const listing = execFileSync("tar", ["-tf", archive], { encoding: "utf8" });
  const packaged = listing.trim().split("\n").filter(Boolean);
  const bad = packaged.filter((file) => forbidden.some((pattern) => pattern.test(file)));
  if (bad.length > 0) {
    process.stderr.write(`Release archive contains private paths:\n${bad.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Release package inventory passed (${String(packaged.length)} files)\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
