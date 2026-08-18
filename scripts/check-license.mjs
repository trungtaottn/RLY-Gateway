#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const license = await readFile(resolve(root, "LICENSE"), "utf8");
if (!license.includes("MIT License")) {
  process.stderr.write("LICENSE is not MIT\n");
  process.exitCode = 1;
}
const copyright = license.split("\n").find((line) => line.startsWith("Copyright")) ?? "";
if (!copyright.includes("Trung Tao")) {
  process.stderr.write("LICENSE copyright was flipped\n");
  process.exitCode = 1;
}
const notices = await readFile(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const provenance = JSON.parse(await readFile(resolve(root, "provenance/artifacts.json"), "utf8"));
if (!notices.includes("MIT License") || !Array.isArray(provenance.artifacts) || provenance.artifacts.length === 0) {
  process.stderr.write("license or provenance inventory is incomplete\n");
  process.exitCode = 1;
}
if (process.exitCode) process.exit(process.exitCode);
process.stdout.write("License and provenance inventory passed\n");
