#!/usr/bin/env node
// Signs the exact standalone tarball bytes before qualification. Full release
// metadata is published only after qualification passes.

import process from "node:process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { signDigestStatement } from "./signing.mjs";

function parseArgs(argv) {
  const options = { releaseDir: undefined, signingKey: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${arg} requires a value`);
    if (arg === "--release-dir") options.releaseDir = next;
    else if (arg === "--signing-key") options.signingKey = next;
    else throw new Error(`unknown argument: ${arg}`);
    index += 1;
  }
  if (options.releaseDir === undefined || options.signingKey === undefined) {
    throw new Error("--release-dir and --signing-key are required");
  }
  return options;
}

async function signingKey(spec) {
  if (spec.startsWith("env:")) {
    const name = spec.slice("env:".length);
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`signing key env ${name} is not set`);
    return value;
  }
  return readFile(resolve(spec), "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const releaseDir = resolve(options.releaseDir);
  const manifest = JSON.parse(await readFile(join(releaseDir, "artifacts.json"), "utf8"));
  const privateKey = await signingKey(options.signingKey);
  for (const artifact of manifest.artifacts ?? []) {
    const tarballPath = join(releaseDir, artifact.name);
    const bytes = await readFile(tarballPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (artifact.sha256 !== undefined && artifact.sha256 !== sha256) {
      throw new Error(`${artifact.name}: sha256 ${sha256} != artifacts.json ${artifact.sha256}`);
    }
    await writeFile(`${tarballPath}.sig`, `${JSON.stringify(signDigestStatement(privateKey, sha256), null, 2)}\n`);
  }
  process.stdout.write(`Signed ${String(manifest.artifacts?.length ?? 0)} exact artifact(s) before qualification\n`);
}

await main().catch((error) => {
  process.stderr.write(`artifact signing failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
