#!/usr/bin/env node
// RLY build provenance / attestation (#128).
//
// Ties each release artifact digest (tarball sha256 + content-addressed tree
// digest) to the exact source revision and release workflow/toolchain inputs
// that produced it — a SLSA-flavored attestation the updater and reviewers
// can verify independently of the mutable GitHub release page. Provenance is
// a sibling release asset generated from the ACTUAL packaged bytes.
//
// The document contains ONLY public build metadata: digests, commit, build
// id, workflow name/run id, toolchain versions, timestamps. No credentials,
// tokens, local state, prompts, responses, or account identity ever enter it.

export const PROVENANCE_SCHEMA_VERSION = 1;
export const PROVENANCE_PREDICATE_TYPE = "https://rly-gateway.dev/provenance/build/v1";
export const PROVENANCE_REPOSITORY_URI = "https://github.com/trungtaottn/RLY-Gateway";

/**
 * Builds the provenance attestation. `artifacts` is a list of
 * { name, sha256, artifactDigest } subjects — the EXACT release artifacts.
 */
export function buildProvenance({
  releaseVersion,
  releaseChannel,
  sourceCommit,
  buildId,
  workflow,
  toolchain,
  inputs,
  artifacts,
  builder,
  buildType,
  reproducible = true,
  completionTimestamp,
  sourceDateEpoch,
}) {
  const subjects = artifacts.map((artifact) => ({
    name: artifact.name,
    digest: {
      sha256: artifact.sha256,
      rlyArtifactDigest: artifact.artifactDigest,
    },
  }));
  return {
    provenanceSchemaVersion: PROVENANCE_SCHEMA_VERSION,
    predicateType: PROVENANCE_PREDICATE_TYPE,
    releaseRef: {
      releaseVersion,
      releaseChannel,
      sourceCommit,
      buildId,
      sourceDateEpoch,
    },
    subject: subjects,
    predicate: {
      builder: {
        id: builder ?? "https://github.com/trungtaottn/RLY-Gateway/.github/workflows/standalone-artifacts.yml",
      },
      buildType: buildType ?? "rly-standalone-artifact",
      invocation: {
        configSource: {
          uri: `${PROVENANCE_REPOSITORY_URI}.git`,
          digest: { gitCommit: sourceCommit },
        },
        parameters: { ...inputs },
        environment: {
          workflow: workflow?.name ?? "unknown",
          runId: workflow?.runId ?? "unknown",
          workflowSha: workflow?.workflowSha ?? sourceCommit,
          os: toolchain?.os ?? "unknown",
          node: toolchain?.node ?? "unknown",
          pnpm: toolchain?.pnpm ?? "unknown",
          // Public toolchain metadata only; secret-bearing environment
          // variables are never recorded (see the privacy gate).
        },
      },
      materials: [
        {
          uri: `${PROVENANCE_REPOSITORY_URI}.git@${sourceCommit}`,
          digest: { gitCommit: sourceCommit },
        },
      ],
      metadata: {
        buildInvocationId: workflow?.runId ?? sourceCommit,
        completionTimestamp,
        reproducible,
      },
    },
  };
}

/** Validates the provenance shape. Returns sorted errors; empty = valid. */
export function validateProvenance(provenance) {
  const errors = [];
  if (provenance === undefined || provenance === null || typeof provenance !== "object") return ["provenance is not an object"];
  if (provenance.provenanceSchemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    errors.push(`provenanceSchemaVersion ${provenance.provenanceSchemaVersion ?? "(missing)"} != ${PROVENANCE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(provenance.subject) || provenance.subject.length === 0) errors.push("subject must be a non-empty list");
  for (const entry of provenance.subject ?? []) {
    if (typeof entry?.name !== "string") errors.push("subject name missing");
    if (entry?.digest === undefined || typeof entry.digest !== "object" || typeof entry.digest.sha256 !== "string") {
      errors.push(`subject ${entry?.name ?? "(?)"} sha256 digest missing`);
    }
    if (typeof entry?.digest?.rlyArtifactDigest !== "string") {
      errors.push(`subject ${entry?.name ?? "(?)"} rlyArtifactDigest missing`);
    }
  }
  const source = provenance?.predicate?.invocation?.configSource;
  if (source === undefined || typeof source.digest?.gitCommit !== "string") errors.push("invocation configSource gitCommit missing");
  return errors.sort();
}

/**
 * Verifies the provenance subjects match the EXACT artifact digests the
 * release actually published. Returns sorted errors; empty = all match.
 */
export function verifyProvenanceSubjects(provenance, expectedSubjects) {
  const errors = [];
  const byName = new Map((provenance?.subject ?? []).map((entry) => [entry.name, entry]));
  for (const expected of expectedSubjects) {
    const entry = byName.get(expected.name);
    if (entry === undefined) {
      errors.push(`provenance has no subject for ${expected.name}`);
      continue;
    }
    if (entry.digest.sha256 !== expected.sha256) {
      errors.push(`provenance sha256 for ${expected.name} ${entry.digest.sha256} != expected ${expected.sha256}`);
    }
    if (entry.digest.rlyArtifactDigest !== expected.artifactDigest) {
      errors.push(`provenance artifactDigest for ${expected.name} ${entry.digest.rlyArtifactDigest} != expected ${expected.artifactDigest}`);
    }
  }
  return errors.sort();
}
