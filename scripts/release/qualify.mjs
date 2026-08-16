#!/usr/bin/env node
// RLY exact-byte qualification runner (#128).
//
// Runs the qualification matrix against the EXACT unpacked artifact bytes
// (the digest later published) and writes `rly-qualification.json` with one
// entry per target. Skipped gates are recorded with reasons and NEVER count
// as passing evidence; a target without full qualification evidence is not
// stable-qualified (enforced machine-readably by verify-release.mjs and the
// channel promotion gate).
//
// Usage:
//   node scripts/release/qualify.mjs --release-dir <dir> --target <t>
//     --version <v> --channel <beta|stable> [--public-key <pem>]
//     [--control-plane-home <dir>] [--verbose]
//
// Reads <release-dir>/rly-<version>-<target>/ (unpacked) and
// <release-dir>/rly-<version>-<target>.tar.gz (+ .sig), merges the result
// into <release-dir>/rly-qualification.json.

import process from "node:process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQualificationGates, serializeQualification } from "./qualification.mjs";
import { RELEASE_MANIFEST_FILENAME } from "./manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PUBLIC_KEY = join(ROOT, "scripts", "release", "signing-public-key.pem");

function parseArgs(argv) {
  const options = {
    releaseDir: undefined,
    target: undefined,
    version: undefined,
    channel: undefined,
    publicKey: DEFAULT_PUBLIC_KEY,
    controlPlaneHome: undefined,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--release-dir": options.releaseDir = value(); break;
      case "--target": options.target = value(); break;
      case "--version": options.version = value(); break;
      case "--channel": options.channel = value(); break;
      case "--public-key": options.publicKey = value(); break;
      case "--control-plane-home": options.controlPlaneHome = value(); break;
      case "--verbose": options.verbose = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  const missing = ["releaseDir", "target", "version", "channel"].filter((key) => options[key] === undefined);
  if (missing.length > 0) throw new Error(`missing required arguments: ${missing.map((key) => `--${key}`).join(", ")}`);
  return options;
}

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const releaseDir = resolve(options.releaseDir);
  const version = options.version;
  const target = options.target;
  const artifactRoot = join(releaseDir, `rly-${version}-${target}`);
  const tarballPath = join(releaseDir, `rly-${version}-${target}.tar.gz`);

  const releaseManifest = await readJsonSafe(join(releaseDir, RELEASE_MANIFEST_FILENAME));
  if (releaseManifest === undefined) throw new Error(`missing ${RELEASE_MANIFEST_FILENAME} in ${releaseDir}; publish the release metadata before qualifying`);
  const artifactMeta = await readJsonSafe(join(artifactRoot, "rly-artifact.json"));
  if (artifactMeta === undefined) throw new Error(`unpacked artifact missing at ${artifactRoot}`);

  const publicKey = await readFile(resolve(options.publicKey), "utf8");
  const qualification = await runQualificationGates({
    artifactRoot,
    tarballPath,
    tarballSha256: releaseManifest.artifacts.find((entry) => entry.target === target)?.sha256,
    artifactDigest: artifactMeta.artifactDigest,
    filename: `rly-${version}-${target}.tar.gz`,
    releaseManifest,
    publicKeyPem: publicKey,
    channel: options.channel,
    target,
    controlPlaneHome: options.controlPlaneHome,
  });
  const document = serializeQualification({ ...qualification, releaseVersion: version });

  const existing = (await readJsonSafe(join(releaseDir, "rly-qualification.json"))) ?? { qualificationSchemaVersion: 1, targets: {} };
  existing.targets = existing.targets ?? {};
  existing.targets[target] = document;
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(releaseDir, "rly-qualification.json"), `${JSON.stringify(existing, null, 2)}\n`);

  if (options.verbose) {
    for (const gate of qualification.gates) {
      process.stdout.write(`  ${gate.id}: ${gate.status}${gate.detail ? ` — ${gate.detail}` : ""}\n`);
    }
  }
  process.stdout.write(`Qualification for ${target} (${version}): ${qualification.result}\n`);
  if (qualification.result === "not-qualified") process.exit(1);
}

await main().catch((error) => {
  process.stderr.write(`qualification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
