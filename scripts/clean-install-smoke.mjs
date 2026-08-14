#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const forbidden = [
  /(^|\/)\.rly\//,
  /(^|\/)\.agent-gateway\//,
  /(^|\/)plans\//,
];
const files = [
  ...execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: root }).trim().split("\n").filter(Boolean),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8", cwd: root }).trim().split("\n").filter(Boolean),
].filter(Boolean);
const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (leaked.length > 0) throw new Error(`clean-install inventory includes private paths: ${leaked.join(", ")}`);

const directory = await mkdtemp(join(tmpdir(), "rly-gateway-clean-install-"));
try {
  const list = join(directory, "files.txt");
  await writeFile(list, `${files.join("\n")}\n`, "utf8");
  execFileSync("tar", ["-cf", join(directory, "src.tar"), "-T", list], { cwd: root });
  execFileSync("tar", ["-xf", join(directory, "src.tar")], { cwd: directory });
  execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: directory, stdio: "inherit" });
  execFileSync("pnpm", ["build"], { cwd: directory, stdio: "inherit" });
  const packageOutput = execFileSync("pnpm", ["pack", "--pack-destination", directory], { cwd: directory, encoding: "utf8" });
  const packageTarball = packageOutput.match(/[^\n]+\.tgz\s*$/)?.[0]?.trim();
  if (!packageTarball) throw new Error("pnpm pack did not report a package tarball");
  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true, packageManager: "pnpm@11.16.0" })}\n`, "utf8");
  // Resolve the packed tarball to an absolute path: pnpm treats a bare `*.tgz`
  // argument as a registry specifier, so a relative basename in a sibling
  // directory would 404 against the npm registry.
  execFileSync("pnpm", ["add", join(directory, packageTarball)], { cwd: consumer, stdio: "inherit" });
  const output = execFileSync("pnpm", ["exec", "rly", "doctor", "--config", "../gateway.config.example.toml"], { cwd: consumer, encoding: "utf8" });
  if (!output.includes('"ok":true') || !output.includes('"codexTarget"')) {
    process.stderr.write(`clean-install doctor output unexpected: ${output}\n`);
    process.exit(1);
  }
  process.stdout.write("Clean-install smoke passed\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
