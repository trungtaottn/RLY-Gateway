#!/usr/bin/env node
// RLY standalone artifact verifier (#35).
//
// Verifies an assembled (unpacked) artifact directory: positive allowlist +
// forbidden-marker absence, exact build/artifact identity consistency
// (rly-build.json == rly.json == rly-artifact.json == dist/rly-build.json),
// recomputed tree digest, and optionally a clean `rly --version` smoke run
// against the BUNDLED node.
//
// Usage:
//   node scripts/standalone/verify-artifact.mjs --artifact <dir> [--target <t>]
//     [--expected-version <v>] [--smoke] [--verbose]

import process from "node:process";
import { verifyArtifactDirectory, smokeRun, hostTarget } from "./pack.mjs";

function parseArgs(argv) {
  const options = { artifact: undefined, target: undefined, expectedVersion: undefined, smoke: false, verbose: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--artifact": options.artifact = value(); break;
      case "--target": options.target = value(); break;
      case "--expected-version": options.expectedVersion = value(); break;
      case "--smoke": options.smoke = true; break;
      case "--verbose": options.verbose = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.artifact === undefined) throw new Error("--artifact <dir> is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const verification = await verifyArtifactDirectory(options.artifact, {
    target: options.target,
    expectedVersion: options.expectedVersion,
  });
  if (!verification.ok) {
    process.stderr.write(`artifact verification FAILED:\n${verification.errors.join("\n")}\n`);
    process.exit(1);
  }
  if (options.verbose) process.stdout.write(`artifact verification passed (${verification.errors.length} errors)\n`);
  if (options.smoke) {
    if (options.target !== undefined && hostTarget() !== options.target) {
      process.stdout.write(`smoke skipped: host ${hostTarget()} cannot execute ${options.target} binaries\n`);
      return;
    }
    const identity = await smokeRun(options.artifact);
    process.stdout.write(`smoke passed: rly --version -> ${JSON.stringify(identity)}\n`);
  }
}

await main().catch((error) => {
  process.stderr.write(`artifact verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
