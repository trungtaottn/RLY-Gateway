#!/usr/bin/env node
// RLY release immutability discipline (#128).
//
// Published stable bytes/digests must not be silently replaced under the same
// release/build identity. GitHub release assets are mutable by default, so
// RLY enforces immutability at the signed-metadata layer:
//
//   - assertReleaseImmutable: when publishing a release whose version already
//     exists in the channel metadata with different artifact digests, refuse
//     (an identical digest re-publish is an idempotent no-write);
//   - detectAssetReplacement: given the signed channel metadata and the
//     actual release asset digests (recomputed from bytes), report any asset
//     whose bytes changed under the same release identity — replacement is
//     DETECTED and therefore unacceptable.
//
// No credentials, tokens, prompts, responses, or user content ever enter this
// module or its outputs.

/**
 * Asserts a new release does not silently replace already-published bytes.
 * `existing` is the prior signed channel metadata (or undefined for the first
 * publish of a version). Returns { ok, errors }.
 */
export function assertReleaseImmutable({ existingMetadata, newManifest }) {
  const errors = [];
  if (existingMetadata === undefined || existingMetadata === null) {
    return { ok: true, errors };
  }
  const newDigests = new Map((newManifest?.artifacts ?? []).map((artifact) => [artifact.target, artifact.artifactDigest]));
  for (const snapshot of existingMetadata.snapshots ?? []) {
    if (snapshot.releaseVersion !== newManifest?.releaseVersion) continue;
    for (const [target, artifact] of Object.entries(snapshot.artifacts ?? {})) {
      const newDigest = newDigests.get(target);
      if (newDigest === undefined) {
        errors.push(`release ${newManifest?.releaseVersion} drops previously published target ${target}`);
        continue;
      }
      if (artifact.artifactDigest !== newDigest) {
        errors.push(
          `immutability violation: release ${newManifest?.releaseVersion} target ${target} digest changed from ${artifact.artifactDigest} to ${newDigest} under the same release identity`,
        );
      }
    }
    if (newDigests.size !== Object.keys(snapshot.artifacts ?? {}).length) {
      const added = [...newDigests.keys()].filter((target) => snapshot.artifacts[target] === undefined);
      if (added.length > 0) errors.push(`release ${newManifest?.releaseVersion} adds new targets to an existing immutable release: ${added.join(", ")}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Detects replacement of published bytes: recompute each release asset's
 * sha256 and compare with the signed channel metadata. Returns entries whose
 * bytes changed under the same release identity (empty = no replacement).
 */
export function detectAssetReplacement({ metadata, assets }) {
  const replaced = [];
  const byKey = new Map();
  for (const snapshot of metadata?.snapshots ?? []) {
    for (const [target, artifact] of Object.entries(snapshot.artifacts ?? {})) {
      byKey.set(`${snapshot.releaseVersion}/${target}`, { expected: artifact, releaseVersion: snapshot.releaseVersion, target });
    }
  }
  for (const asset of assets ?? []) {
    const key = `${asset.releaseVersion}/${asset.target}`;
    const entry = byKey.get(key);
    if (entry === undefined) continue;
    if (asset.sha256 !== entry.expected.sha256 || asset.artifactDigest !== entry.expected.artifactDigest) {
      replaced.push({
        releaseVersion: entry.releaseVersion,
        target: entry.target,
        filename: asset.filename,
        expectedSha256: entry.expected.sha256,
        actualSha256: asset.sha256,
        expectedArtifactDigest: entry.expected.artifactDigest,
        actualArtifactDigest: asset.artifactDigest,
      });
    }
  }
  return replaced;
}
