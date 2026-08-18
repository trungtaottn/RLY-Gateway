#!/usr/bin/env node
// RLY release supply-chain publisher (#128).
//
// Consumes the #35 artifact lineage (`out/standalone/`: tarballs + sha256 +
// artifacts.json + unpacked artifact dirs) and emits the signed release
// supply-chain assets beside them:
//
//   rly-release.json (+ .sig)                 canonical release manifest
//   rly-<v>-<target>.sbom.json                SBOM per artifact (exact digest ref)
//   rly-provenance.json (+ .sig)              build provenance/attestation
//   rly-channel-<channel>.json (+ .sig)       signed channel metadata
//   rly-<v>-<target>.tar.gz.sig               per-artifact Ed25519 signature
//
// The PRIVATE signing key is NEVER in the repository: pass --signing-key
// <path> or env:NAME (the GitHub Actions secret RLY_RELEASE_SIGNING_KEY).
// The PUBLIC key is the committed scripts/release/signing-public-key.pem.
//
// Usage:
//   node scripts/release/publish.mjs --release-dir <dir> --version <v>
//     --channel <beta|stable> --source-commit <sha> --build-id <id>
//     --signing-key <path|env:NAME> [--public-key <pem>] [--out <dir>]
//     [--workflow-name <n>] [--workflow-run-id <id>] [--workflow-sha <sha>]
//     [--toolchain-node <v>] [--toolchain-pnpm <v>] [--toolchain-os <os>]
//     [--published-at <iso>] [--previous-highest-version <n>]
//     [--freeze] [--freeze-reason <r>] [--qualification <path>] [--verbose]

import process from "node:process";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildReleaseManifest, serializeReleaseManifest, validateReleaseManifest, releaseManifestMatchesIdentity } from "./manifest.mjs";
import { buildSbomForArtifact, validateSbom } from "./sbom.mjs";
import { buildProvenance, validateProvenance } from "./provenance.mjs";
import { buildChannelMetadata, validateChannelMetadata, qualificationStatusForChannel } from "./channel.mjs";
import { signJson, signDigestStatement, publicKeyFingerprint } from "./signing.mjs";
import { assertReleaseImmutable } from "./immutability.mjs";
import { qualificationArtifactBindingErrors, qualificationTargetSetErrors } from "./qualification.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PUBLIC_KEY = join(ROOT, "scripts", "release", "signing-public-key.pem");

function parseArgs(argv) {
  const options = {
    releaseDir: undefined,
    version: undefined,
    channel: undefined,
    sourceCommit: undefined,
    buildId: undefined,
    signingKey: undefined,
    publicKey: DEFAULT_PUBLIC_KEY,
    out: undefined,
    workflowName: "standalone-artifacts",
    workflowRunId: "local",
    workflowSha: undefined,
    toolchainNode: process.versions.node,
    toolchainPnpm: "unknown",
    toolchainOs: process.platform,
    publishedAt: new Date().toISOString(),
    previousHighestVersion: 0,
    freeze: false,
    freezeReason: "",
    qualification: undefined,
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
      case "--version": options.version = value(); break;
      case "--channel": options.channel = value(); break;
      case "--source-commit": options.sourceCommit = value(); break;
      case "--build-id": options.buildId = value(); break;
      case "--signing-key": options.signingKey = value(); break;
      case "--public-key": options.publicKey = value(); break;
      case "--out": options.out = value(); break;
      case "--workflow-name": options.workflowName = value(); break;
      case "--workflow-run-id": options.workflowRunId = value(); break;
      case "--workflow-sha": options.workflowSha = value(); break;
      case "--toolchain-node": options.toolchainNode = value(); break;
      case "--toolchain-pnpm": options.toolchainPnpm = value(); break;
      case "--toolchain-os": options.toolchainOs = value(); break;
      case "--published-at": options.publishedAt = value(); break;
      case "--previous-highest-version": options.previousHighestVersion = Number(value()); break;
      case "--freeze": options.freeze = true; break;
      case "--freeze-reason": options.freezeReason = value(); options.freeze = true; break;
      case "--qualification": options.qualification = value(); break;
      case "--verbose": options.verbose = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  const missing = ["releaseDir", "version", "channel", "signingKey"].filter((key) => options[key] === undefined);
  if (missing.length > 0) throw new Error(`missing required arguments: ${missing.map((key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(", ")}`);
  return options;
}

function sha256Of(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function resolveSigningKey(spec) {
  if (spec.startsWith("env:")) {
    const name = spec.slice("env:".length);
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`signing key env ${name} is not set`);
    return value;
  }
  return readFile(resolve(spec), "utf8");
}

async function collectArtifacts(releaseDir, version) {
  const manifest = await readJson(join(releaseDir, "artifacts.json"));
  if (manifest.releaseVersion !== version) {
    throw new Error(`artifacts.json releaseVersion ${manifest.releaseVersion} != requested ${version}`);
  }
  const collected = [];
  for (const record of manifest.artifacts ?? []) {
    const tarballPath = join(releaseDir, record.name);
    const info = await stat(tarballPath).catch(() => undefined);
    if (info === undefined) throw new Error(`tarball ${record.name} missing in ${releaseDir}`);
    const bytes = await readFile(tarballPath);
    const sha256 = sha256Of(bytes);
    const unpackedDir = join(releaseDir, record.name.replace(/\.tar\.gz$/, ""));
    const artifactMeta = await readJson(join(unpackedDir, "rly-artifact.json")).catch(() => undefined);
    const buildMeta = await readJson(join(unpackedDir, "rly-build.json")).catch(() => undefined);
    if (artifactMeta === undefined) throw new Error(`rly-artifact.json missing for ${record.name}`);
    if (buildMeta === undefined) throw new Error(`rly-build.json missing for ${record.name}`);
    collected.push({
      name: record.name,
      target: record.targetPlatform ?? artifactMeta.targetPlatform,
      sizeBytes: info.size,
      sha256,
      artifactDigest: artifactMeta.artifactDigest,
      targetStatus: artifactMeta.targetStatus,
      targetStatusReason: artifactMeta.targetStatusReason,
      bundledNodeVersion: artifactMeta.bundledNodeVersion,
      bundledNodeVersionSource: artifactMeta.bundledNodeVersionSource,
      unpackedDir,
      buildMeta,
      tarballPath,
    });
  }
  collected.sort((left, right) => (left.target < right.target ? -1 : left.target > right.target ? 1 : 0));
  return { manifest, collected };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const releaseDir = resolve(options.releaseDir);
  const outDir = resolve(options.out ?? releaseDir);
  const privateKey = await resolveSigningKey(options.signingKey);
  const publicKey = await readFile(resolve(options.publicKey), "utf8");

  const { collected } = await collectArtifacts(releaseDir, options.version);
  const qualification = await readQualification(options.qualification, releaseDir, outDir);
  if (options.channel === "stable") {
    const targetErrors = qualificationTargetSetErrors(collected.map((artifact) => artifact.target), qualification);
    const bindingErrors = qualificationArtifactBindingErrors(
      collected.map((artifact) => ({
        target: artifact.target,
        filename: artifact.name,
        sha256: artifact.sha256,
        artifactDigest: artifact.artifactDigest,
      })),
      qualification,
      { releaseVersion: options.version, channel: options.channel },
    );
    const qualificationErrors = [...targetErrors, ...bindingErrors];
    if (qualificationErrors.length > 0) {
      throw new Error(`stable qualification evidence mismatch:\n  - ${qualificationErrors.join("\n  - ")}`);
    }
  }

  const identity = collected[0].buildMeta;
  // Source commit / build id default to the EXACT build identity embedded in
  // the packaged bytes; the verify step still cross-checks every artifact's
  // rly-build.json against the published manifest (identity enforcement).
  const sourceCommit = options.sourceCommit ?? identity.commitRevision;
  const buildId = options.buildId ?? identity.buildId;
  const manifest = buildReleaseManifest({
    releaseVersion: options.version,
    releaseChannel: options.channel,
    sourceCommit,
    buildId,
    stateSchemaVersion: identity.stateSchemaVersion,
    controlProtocolVersion: identity.controlProtocolVersion,
    dataProtocolVersion: identity.dataProtocolVersion,
    publishedAt: options.publishedAt,
    workflow: {
      name: options.workflowName,
      runId: options.workflowRunId,
      workflowSha: options.workflowSha ?? sourceCommit,
      toolchain: { node: options.toolchainNode, pnpm: options.toolchainPnpm, os: options.toolchainOs },
    },
    artifacts: collected.map((artifact) => ({
      target: artifact.target,
      filename: artifact.name,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      artifactDigest: artifact.artifactDigest,
      targetStatus: artifact.targetStatus,
      targetStatusReason: artifact.targetStatusReason,
      bundledNodeVersion: artifact.bundledNodeVersion,
      bundledNodeVersionSource: artifact.bundledNodeVersionSource,
      requiredSignatures: ["ed25519-sha256"],
      attestations: [`${artifact.name.replace(/\.tar\.gz$/, "")}.sbom.json`],
    })),
  });

  const manifestErrors = validateReleaseManifest(manifest);
  if (manifestErrors.length > 0) throw new Error(`release manifest invalid:\n  - ${manifestErrors.join("\n  - ")}`);
  const identityErrors = releaseManifestMatchesIdentity(manifest, identity);
  if (identityErrors.length > 0) throw new Error(`release manifest identity mismatch:\n  - ${identityErrors.join("\n  - ")}`);

  // Immutability discipline: never silently replace published bytes.
  const previousChannelPath = join(outDir, `rly-channel-${options.channel}.json`);
  let previousMetadata;
  try {
    previousMetadata = JSON.parse(await readFile(previousChannelPath, "utf8"));
  } catch {
    previousMetadata = undefined;
  }
  const immutable = assertReleaseImmutable({ existingMetadata: previousMetadata, newManifest: manifest });
  if (!immutable.ok) throw new Error(`immutability check failed:\n  - ${immutable.errors.join("\n  - ")}`);

  await mkdir(outDir, { recursive: true });

  // 1. Canonical release manifest + signature.
  await writeFile(join(outDir, "rly-release.json"), serializeReleaseManifest(manifest));
  await writeJson(join(outDir, "rly-release.json.sig"), signJson(privateKey, manifest));

  // 2. Per-artifact SBOM (from the ACTUAL unpacked bytes) + signatures.
  for (const artifact of collected) {
    const sbom = await buildSbomForArtifact(artifact.unpackedDir, {
      filename: artifact.name,
      sha256: artifact.sha256,
      artifactDigest: artifact.artifactDigest,
      releaseVersion: options.version,
      releaseChannel: options.channel,
      target: artifact.target,
      sourceDateEpoch: 0,
    });
    const sbomErrors = validateSbom(sbom);
    if (sbomErrors.length > 0) throw new Error(`SBOM invalid for ${artifact.name}:\n  - ${sbomErrors.join("\n  - ")}`);
    await writeJson(join(outDir, `${artifact.name.replace(/\.tar\.gz$/, "")}.sbom.json`), sbom);
    await writeJson(join(outDir, `${artifact.name}.sig`), signDigestStatement(privateKey, artifact.sha256));
  }

  // 3. Provenance / attestation.
  const provenance = buildProvenance({
    releaseVersion: options.version,
    releaseChannel: options.channel,
    sourceCommit,
    buildId,
    workflow: { name: options.workflowName, runId: options.workflowRunId, workflowSha: options.workflowSha ?? sourceCommit },
    toolchain: { node: options.toolchainNode, pnpm: options.toolchainPnpm, os: options.toolchainOs },
    inputs: { releaseVersion: options.version, channel: options.channel, targets: collected.map((artifact) => artifact.target) },
    artifacts: collected.map((artifact) => ({ name: artifact.name, sha256: artifact.sha256, artifactDigest: artifact.artifactDigest })),
    completionTimestamp: options.publishedAt,
    sourceDateEpoch: 0,
  });
  const provenanceErrors = validateProvenance(provenance);
  if (provenanceErrors.length > 0) throw new Error(`provenance invalid:\n  - ${provenanceErrors.join("\n  - ")}`);
  await writeJson(join(outDir, "rly-provenance.json"), provenance);
  await writeJson(join(outDir, "rly-provenance.json.sig"), signJson(privateKey, provenance));

  // 4. Signed channel metadata (TUF-style separation of metadata from artifacts).
  const qualificationByTarget = qualification?.targets ?? {};
  const qualificationRef = qualification === undefined ? undefined : "rly-qualification.json";
  const artifactDigests = Object.fromEntries(
    collected.map((artifact) => [
      artifact.target,
      { filename: artifact.name, sha256: artifact.sha256, artifactDigest: artifact.artifactDigest, targetStatus: artifact.targetStatus },
    ]),
  );
  const channelMetadata = buildChannelMetadata({
    channel: options.channel,
    releaseVersion: options.version,
    sourceCommit: options.sourceCommit,
    buildId: options.buildId,
    publishedAt: options.publishedAt,
    artifactDigests,
    qualification: {
      status: qualificationStatusForChannel(qualificationByTarget, options.channel),
      ref: qualificationRef,
    },
    previousHighestVersion: options.previousHighestVersion,
    freeze: options.freeze ? { frozen: true, reason: options.freezeReason } : { frozen: false },
    updatedAt: options.publishedAt,
  });
  const channelErrors = validateChannelMetadata(channelMetadata);
  if (channelErrors.length > 0) throw new Error(`channel metadata invalid:\n  - ${channelErrors.join("\n  - ")}`);
  await writeJson(join(outDir, `rly-channel-${options.channel}.json`), channelMetadata);
  await writeJson(join(outDir, `rly-channel-${options.channel}.json.sig`), signJson(privateKey, channelMetadata));

  // 5. Copy the qualification evidence beside the metadata (already referenced).
  if (qualification !== undefined) {
    await writeJson(join(outDir, "rly-qualification.json"), qualification);
  }

  if (options.verbose) {
    process.stdout.write(
      `Published release supply-chain assets for ${options.version} (${options.channel}, version ${channelMetadata.version}, key ${publicKeyFingerprint(publicKey).slice(0, 16)}…):\n` +
        `  - ${collected.length} artifact signatures + SBOMs\n` +
        `  - rly-release.json, rly-provenance.json, rly-channel-${options.channel}.json (+ .sig)\n`,
    );
  } else {
    process.stdout.write(`Release supply chain published for ${options.version} (${options.channel}) in ${outDir}\n`);
  }
}

async function readQualification(specifiedPath, releaseDir, outDir) {
  const candidates = [
    specifiedPath !== undefined ? resolve(specifiedPath) : undefined,
    join(releaseDir, "rly-qualification.json"),
    join(outDir, "rly-qualification.json"),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      return parsed.targets === undefined ? { targets: { [parsed.target]: parsed } } : parsed;
    } catch {
      // try next
    }
  }
  return undefined;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

await main().catch((error) => {
  process.stderr.write(`release publish failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
