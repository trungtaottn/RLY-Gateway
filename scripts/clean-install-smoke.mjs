#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const files = [
  ...execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: root }).trim().split("\n").filter(Boolean),
  ...execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8", cwd: root }).trim().split("\n").filter(Boolean),
].filter((file) => file && !file.startsWith("plans/"));

const directory = await mkdtemp(join(tmpdir(), "agent-gateway-clean-install-"));
try {
  const list = join(directory, "files.txt");
  await writeFile(list, `${files.join("\n")}\n`, "utf8");
  execFileSync("tar", ["-cf", join(directory, "src.tar"), "-T", list], { cwd: root });
  execFileSync("tar", ["-xf", join(directory, "src.tar")], { cwd: directory });
  execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: directory, stdio: "inherit" });
  execFileSync("pnpm", ["build"], { cwd: directory, stdio: "inherit" });
  const output = execFileSync("node", ["dist/cli/main.js", "doctor", "--config", "gateway.config.example.toml"], { cwd: directory, encoding: "utf8" });
  if (!output.includes('"ok":true') || !output.includes('"codexTarget"')) {
    process.stderr.write(`clean-install doctor output unexpected: ${output}\n`);
    process.exit(1);
  }
  process.stdout.write("Clean-install smoke passed\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
