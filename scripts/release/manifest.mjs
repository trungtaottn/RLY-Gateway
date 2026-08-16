#!/usr/bin/env node
// RLY canonical release manifest (#128).
//
// Binds product version, release channel, source commit/build ID, every
// supported target, artifact filename/size/digest, the bundled runtime
// version, state/protocol compatibility, and the required signatures and
// attestations for the release — aligned with the #94 exact build identity
// (`rly-build.json`) and the #35 artifact lineage. The manifest is the
// machine-readable authority the #129 verified updater consumes; it NEVER
// trusts a mutable GitHub `latest` target alone.
//
// No credentials, tokens, prompts, responses, or user content ever enter this
// module or its outputs.

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const RELEASE_MANIFEST_FILENAME = "rly-release.json";
export const REQUIRED_SIGNATURES = ["ed25519-sha256"];
export const REQUIRED_ATTESTATIONS = ["rly-sbom.json", "rly-provenance.json"];

/**
 * Builds the canonical release manifest from release metadata and per-target
 * artifact records (from the #35 `artifacts.json` lineage).
 */
export function buildReleaseManifest({
  releaseVersion,
  releaseChannel,
  sourceCommit,
  buildId,
  stateSchemaVersion,
  controlProtocolVersion,
  dataProtocolVersion,
  publishedAt,
  workflow,
  artifacts,
  requiredSignatures = REQUIRED_SIGNATURES,
  requiredAttestations = REQUIRED_ATTESTATIONS,
}) {
  return {
    manifestSchemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    product: "rly-gateway",
    releaseVersion,
    releaseChannel,
    sourceCommit,
    buildId,
    stateSchemaVersion,
    controlProtocolVersion,
    dataProtocolVersion,
    publishedAt,
    requiredSignatures,
    requiredAttestations,
    workflow,
    artifacts,
  };
}

/**
 * Validates the manifest shape. Returns a sorted list of human-readable
 * errors; an empty list means the manifest is a legal canonical release
 * manifest.
 */
export function validateReleaseManifest(manifest) {
  const errors = [];
  if (manifest === undefined || manifest === null || typeof manifest !== "object") {
    return ["release manifest is not an object"];
  }
  if (manifest.manifestSchemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    errors.push(`manifestSchemaVersion ${manifest.manifestSchemaVersion ?? "(missing)"} != ${RELEASE_MANIFEST_SCHEMA_VERSION}`);
  }
  if (manifest.product !== "rly-gateway") errors.push(`product ${manifest.product ?? "(missing)"} != rly-gateway`);
  if (typeof manifest.releaseVersion !== "string" || manifest.releaseVersion.length === 0) errors.push("releaseVersion missing");
  if (!["beta", "stable"].includes(manifest.releaseChannel)) errors.push(`releaseChannel ${manifest.releaseChannel ?? "(missing)"} not beta|stable`);
  if (typeof manifest.sourceCommit !== "string" || manifest.sourceCommit.length === 0) errors.push("sourceCommit missing");
  if (typeof manifest.buildId !== "string" || manifest.buildId.length === 0) errors.push("buildId missing");
  for (const [field, name] of [
    ["stateSchemaVersion", "stateSchemaVersion"],
    ["controlProtocolVersion", "controlProtocolVersion"],
    ["dataProtocolVersion", "dataProtocolVersion"],
  ]) {
    if (typeof manifest[field] !== "number" || !Number.isInteger(manifest[field]) || manifest[field] <= 0) {
      errors.push(`${name} missing or non-positive`);
    }
  }
  if (typeof manifest.publishedAt !== "string" || Number.isNaN(Date.parse(manifest.publishedAt))) {
    errors.push("publishedAt missing or not an ISO timestamp");
  }
  if (!Array.isArray(manifest.requiredSignatures) || manifest.requiredSignatures.length === 0) {
    errors.push("requiredSignatures must be a non-empty list");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    errors.push("artifacts must be a non-empty list");
  }
  const seenTargets = new Set();
  for (const artifact of manifest.artifacts ?? []) {
    if (artifact === null || typeof artifact !== "object") {
      errors.push("artifact entry is not an object");
      continue;
    }
    const { target, filename, sizeBytes, sha256, artifactDigest, targetStatus } = artifact;
    if (typeof target !== "string" || target.length === 0) errors.push("artifact target missing");
    else if (seenTargets.has(target)) errors.push(`duplicate artifact target: ${target}`);
    else seenTargets.add(target);
    if (typeof filename !== "string" || filename.length === 0) errors.push(`artifact ${target ?? "(?)"} filename missing`);
    if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
      errors.push(`artifact ${target ?? "(?)"} sizeBytes missing or invalid`);
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) errors.push(`artifact ${target ?? "(?)"} sha256 invalid`);
    if (typeof artifactDigest !== "string" || !/^[0-9a-f]{64}$/.test(artifactDigest)) {
      errors.push(`artifact ${target ?? "(?)"} artifactDigest invalid`);
    }
    if (!["supported", "experimental"].includes(targetStatus)) {
      errors.push(`artifact ${target ?? "(?)"} targetStatus ${targetStatus ?? "(missing)"} not supported|experimental`);
    }
    if (!Array.isArray(artifact.requiredSignatures) || artifact.requiredSignatures.length === 0) {
      errors.push(`artifact ${target ?? "(?)"} requiredSignatures missing`);
    }
    if (!Array.isArray(artifact.attestations) || artifact.attestations.length === 0) {
      errors.push(`artifact ${target ?? "(?)"} attestations missing`);
    }
  }
  return errors.sort();
}

/** Per-target artifact digest map ({ target: artifactDigest }) for exact-byte comparisons. */
export function releaseManifestArtifactDigests(manifest) {
  const digests = {};
  for (const artifact of manifest.artifacts ?? []) {
    digests[artifact.target] = artifact.artifactDigest;
  }
  return digests;
}

/** Per-target sha256 map ({ target: sha256 }) for the trust chain. */
export function releaseManifestSha256s(manifest) {
  const digests = {};
  for (const artifact of manifest.artifacts ?? []) {
    digests[artifact.target] = artifact.sha256;
  }
  return digests;
}

/**
 * Cross-checks the release manifest against the #94 exact build identity
 * fields of the release build (`rly-build.json`/`dist/rly-build.json`).
 * An exact release must agree on version, commit, build ID, channel, and the
 * control/data/state schema versions — a split identity is a hard failure.
 */
export function releaseManifestMatchesIdentity(manifest, buildMeta) {
  const errors = [];
  if (manifest.releaseVersion !== buildMeta.semanticVersion) {
    errors.push(`releaseVersion ${manifest.releaseVersion} != build identity semanticVersion ${buildMeta.semanticVersion}`);
  }
  if (manifest.sourceCommit !== buildMeta.commitRevision) {
    errors.push(`sourceCommit ${manifest.sourceCommit} != build identity commitRevision ${buildMeta.commitRevision}`);
  }
  if (manifest.buildId !== buildMeta.buildId) {
    errors.push(`buildId ${manifest.buildId} != build identity buildId ${buildMeta.buildId}`);
  }
  if (manifest.releaseChannel !== buildMeta.releaseChannel) {
    errors.push(`releaseChannel ${manifest.releaseChannel} != build identity releaseChannel ${buildMeta.releaseChannel}`);
  }
  if (manifest.controlProtocolVersion !== buildMeta.controlProtocolVersion) {
    errors.push(`controlProtocolVersion mismatch: ${manifest.controlProtocolVersion} != ${buildMeta.controlProtocolVersion}`);
  }
  if (manifest.dataProtocolVersion !== buildMeta.dataProtocolVersion) {
    errors.push(`dataProtocolVersion mismatch: ${manifest.dataProtocolVersion} != ${buildMeta.dataProtocolVersion}`);
  }
  if (manifest.stateSchemaVersion !== buildMeta.stateSchemaVersion) {
    errors.push(`stateSchemaVersion mismatch: ${manifest.stateSchemaVersion} != ${buildMeta.stateSchemaVersion}`);
  }
  return errors;
}

/**
 * Serializes the manifest with canonical JSON so the detached signature and
 * the published bytes always agree.
 */
export function serializeReleaseManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
