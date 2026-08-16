#!/usr/bin/env node
// RLY release supply-chain verifier (#128).
//
// Verifies the published release assets in a release directory:
//   - canonical release manifest shape + #94 identity consistency,
//   - every artifact tarball's actual sha256/size matches the manifest and
//     its Ed25519 signature verifies against the committed public key,
//   - every SBOM references the EXACT artifact digest,
//   - provenance subjects match the exact digests and the signature verifies,
//   - signed channel metadata verifies and evaluates rollback/staleness/
//     freeze, with beta vs stable qualification gates enforced
//     (a missing/failed gate BLOCKS stable promotion),
//   - release immutability: replacing published bytes under the same release
//     identity is detected (actual bytes vs signed metadata).
//
// Exit code 0 = the release is authentic and qualified for the requested
// channel; any failure exits non-zero with actionable errors. No secrets are
// read or printed.
//
// Usage:
//   node scripts/release/verify-release.mjs --release-dir <dir>
//     [--public-key <pem>] [--channel <beta|stable>] [--version <v>]
//     [--highest-observed-version <n>] [--now <iso>] [--verbose]

import process from "node:process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { validateReleaseManifest, releaseManifestMatchesIdentity } from "./manifest.mjs";
import { validateSbom, verifySbomArtifactRef } from "./sbom.mjs";
import { validateProvenance, verifyProvenanceSubjects } from "./provenance.mjs";
import { validateChannelMetadata, evaluateChannelMetadata } from "./channel.mjs";
import { verifyJsonSignature, verifyDigestStatement, publicKeyFingerprint } from "./signing.mjs";
import { detectAssetReplacement } from "./immutability.mjs";
import { qualificationBlocksStable } from "./qualification.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PUBLIC_KEY = join(ROOT, "scripts", "release", "signing-public-key.pem");

function parseArgs(argv) {
  const options = {
    releaseDir: undefined,
    publicKey: DEFAULT_PUBLIC_KEY,
    channel: undefined,
    version: undefined,
    highestObservedVersion: 0,
    now: new Date().toISOString(),
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
      case "--public-key": options.publicKey = value(); break;
      case "--channel": options.channel = value(); break;
      case "--version": options.version = value(); break;
      case "--highest-observed-version": options.highestObservedVersion = Number(value()); break;
      case "--now": options.now = value(); break;
      case "--verbose": options.verbose = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.releaseDir === undefined) throw new Error("--release-dir is required");
  return options;
}

function sha256Of(data) {
  return createHash("sha256").update(data).digest("hex");
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
  const publicKey = await readFile(resolve(options.publicKey), "utf8");
  const errors = [];
  const notes = [];

  const manifest = await readJsonSafe(join(releaseDir, "rly-release.json"));
  if (manifest === undefined) errors.push("missing rly-release.json (canonical release manifest)");
  else {
    errors.push(...validateReleaseManifest(manifest));
    if (options.version !== undefined && manifest.releaseVersion !== options.version) {
      errors.push(`manifest releaseVersion ${manifest.releaseVersion} != requested ${options.version}`);
    }
  }

  const provenance = await readJsonSafe(join(releaseDir, "rly-provenance.json"));
  if (provenance === undefined) errors.push("missing rly-provenance.json");
  else {
    errors.push(...validateProvenance(provenance));
    const sig = await readJsonSafe(join(releaseDir, "rly-provenance.json.sig"));
    if (sig === undefined) errors.push("missing rly-provenance.json.sig");
    else if (!verifyJsonSignature(publicKey, provenance, sig)) errors.push("rly-provenance.json signature does not verify");
  }

  let channelMetadata;
  if (options.channel !== undefined) {
    channelMetadata = await readJsonSafe(join(releaseDir, `rly-channel-${options.channel}.json`));
    if (channelMetadata === undefined) errors.push(`missing rly-channel-${options.channel}.json`);
    else {
      errors.push(...validateChannelMetadata(channelMetadata));
      const sig = await readJsonSafe(join(releaseDir, `rly-channel-${options.channel}.json.sig`));
      if (sig === undefined) errors.push(`missing rly-channel-${options.channel}.json.sig`);
      else if (!verifyJsonSignature(publicKey, channelMetadata, sig)) errors.push(`rly-channel-${options.channel}.json signature does not verify`);
      const evaluation = evaluateChannelMetadata(channelMetadata, {
        highestObservedVersion: options.highestObservedVersion,
        now: options.now,
      });
      if (!evaluation.ok) errors.push(`channel metadata evaluation failed: ${evaluation.errors.join("; ")}`);
      else notes.push(`channel metadata evaluation ok (version ${channelMetadata.version}, age ${evaluation.ageDays?.toFixed(1)} days)`);
    }
  }

  // Per-artifact verification: manifest entry, actual bytes, signature, SBOM.
  const expectedSubjects = [];
  const actualAssets = [];
  for (const artifact of manifest?.artifacts ?? []) {
    const { target, filename, sha256, sizeBytes, artifactDigest } = artifact;
    const tarballPath = join(releaseDir, filename);
    const info = await stat(tarballPath).catch(() => undefined);
    if (info === undefined) {
      errors.push(`missing artifact tarball ${filename}`);
      continue;
    }
    const bytes = await readFile(tarballPath);
    const actualSha256 = sha256Of(bytes);
    if (actualSha256 !== sha256) errors.push(`${filename}: actual sha256 ${actualSha256} != manifest ${sha256} (replacement or corruption)`);
    if (info.size !== sizeBytes) errors.push(`${filename}: actual size ${info.size} != manifest ${sizeBytes}`);
    const sig = await readJsonSafe(`${tarballPath}.sig`);
    if (sig === undefined) errors.push(`${filename}: missing .sig`);
    else if (!verifyDigestStatement(publicKey, sha256, sig)) errors.push(`${filename}: signature does not verify against the release public key`);
    else notes.push(`${filename}: signature verifies`);

    const sbom = await readJsonSafe(join(releaseDir, `${filename.replace(/\.tar\.gz$/, "")}.sbom.json`));
    if (sbom === undefined) errors.push(`${filename}: missing SBOM`);
    else {
      errors.push(...validateSbom(sbom));
      errors.push(...verifySbomArtifactRef(sbom, { filename, sha256, artifactDigest }));
    }

    // Identity consistency with the unpacked artifact's build metadata.
    const unpackedBuildMeta = await readJsonSafe(join(releaseDir, filename.replace(/\.tar\.gz$/, ""), "rly-build.json"));
    if (unpackedBuildMeta !== undefined && manifest !== undefined) {
      errors.push(...releaseManifestMatchesIdentity(manifest, unpackedBuildMeta));
    } else if (unpackedBuildMeta === undefined) {
      errors.push(`${filename}: unpacked rly-build.json missing (cannot verify identity consistency)`);
    }

    expectedSubjects.push({ name: filename, sha256, artifactDigest });
    actualAssets.push({ releaseVersion: manifest.releaseVersion, target, filename, sha256: actualSha256, artifactDigest });
  }

  if (provenance !== undefined && expectedSubjects.length > 0) {
    errors.push(...verifyProvenanceSubjects(provenance, expectedSubjects));
  }

  // Release immutability: published bytes vs signed metadata (replacement detection).
  if (manifest !== undefined && actualAssets.length > 0) {
    const replaced = detectAssetReplacement({ metadata: channelMetadata, assets: actualAssets });
    for (const entry of replaced) {
      errors.push(
        `immutability violation: ${entry.filename} bytes changed under release ${entry.releaseVersion} (sha256 ${entry.actualSha256} != published ${entry.expectedSha256})`,
      );
    }
  }

  // Qualification gate: a missing/failed required gate blocks stable promotion.
  if (options.channel === "stable") {
    const qualification = await readJsonSafe(join(releaseDir, "rly-qualification.json"));
    if (qualification === undefined) {
      errors.push("stable channel requires rly-qualification.json evidence (exact-byte qualification is the publication authority)");
    } else {
      for (const target of Object.keys(qualification.targets ?? {}).sort()) {
        const blockers = qualificationBlocksStable(qualification.targets[target]);
        if (blockers.length > 0) {
          errors.push(`stable qualification blocked for ${target}: ${blockers.join("; ")}`);
        } else {
          notes.push(`stable qualification passed for ${target} (exact digest ${qualification.targets[target].qualifiedBytes?.artifactDigest?.slice(0, 16)}…)`);
        }
      }
    }
  }

  if (options.verbose) {
    process.stdout.write(`Verifying release in ${releaseDir} with public key ${publicKeyFingerprint(publicKey).slice(0, 16)}…\n`);
    for (const note of notes) process.stdout.write(`  ok: ${note}\n`);
  }

  if (errors.length > 0) {
    process.stderr.write(`Release verification FAILED:\n  - ${errors.join("\n  - ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Release verification passed (${expectedSubjects.length} artifacts verified)\n`);
}

await main().catch((error) => {
  process.stderr.write(`release verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
