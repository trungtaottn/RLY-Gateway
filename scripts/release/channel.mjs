#!/usr/bin/env node
// RLY signed channel metadata (#128).
//
// A small signed metadata layer mapping each release channel (beta/stable) to
// the EXACT release/build/artifact digests it points at — TUF-style
// separation of metadata from artifacts. The updater MUST verify this
// signature and NEVER trust a mutable GitHub "latest" redirect alone.
//
// Explicit semantics:
//   - rollback protection: `version` is a monotonic per-channel counter; a
//     client refuses metadata whose version is lower than the highest it has
//     observed (an attacker reverting a channel to an older release is
//     detected);
//   - staleness: `updatedAt` + `staleness.maxAgeDays`; metadata older than
//     the window is stale and the updater must refuse it;
//   - freeze: an explicit `freeze.frozen` marker blocks activation beyond the
//     frozen snapshot (deliberate incident/QA freeze, machine-readable);
//   - beta vs stable: per-target qualification status is recorded so beta
//     experimental gaps are explicit and can never masquerade as stable
//     qualification.
//
// No credentials, tokens, prompts, responses, or user content ever enter this
// module or its outputs.

export const CHANNEL_METADATA_SCHEMA_VERSION = 1;
export const CHANNEL_MAX_AGE_DAYS = 30;
export const CHANNELS = ["beta", "stable"];
export const CHANNEL_METADATA_FILENAME = (channel) => `rly-channel-${channel}.json`;

/**
 * Deterministic monotonic counter for a release version on a channel:
 *   beta   `1.0.0-beta.<n>`  -> n
 *   stable `<major>.<minor>.<patch>` -> a monotonic SemVer rank
 * Returns null when the version is not a valid version for that channel.
 */
export function channelVersionFor(releaseVersion, channel) {
  if (channel === "beta") {
    const match = /^\d+\.\d+\.\d+-beta\.(\d+)$/.exec(releaseVersion);
    return match === null ? null : Number(match[1]);
  }
  if (channel === "stable") {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(releaseVersion);
    if (match === null) return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (major > 999 || minor > 999 || patch > 999) return null;
    return (major * 1_000_000) + (minor * 1_000) + patch;
  }
  return null;
}

/**
 * Builds channel metadata for a release. `previousHighestVersion` is the
 * highest per-channel counter the publisher knows about (from the last
 * published metadata); the new version is strictly monotonic.
 */
export function buildChannelMetadata({
  channel,
  releaseVersion,
  sourceCommit,
  buildId,
  publishedAt,
  artifactDigests,
  qualification,
  previousHighestVersion = 0,
  freeze = { frozen: false },
  stalenessMaxAgeDays = CHANNEL_MAX_AGE_DAYS,
  updatedAt,
}) {
  if (!CHANNELS.includes(channel)) throw new Error(`unknown release channel: ${channel}`);
  const releaseCounter = channelVersionFor(releaseVersion, channel);
  if (releaseCounter === null) {
    throw new Error(`release version ${releaseVersion} is not a valid ${channel} version`);
  }
  const version = Math.max(previousHighestVersion + 1, releaseCounter);
  return {
    channelSchemaVersion: CHANNEL_METADATA_SCHEMA_VERSION,
    channel,
    version,
    updatedAt: updatedAt ?? publishedAt,
    staleness: { maxAgeDays: stalenessMaxAgeDays },
    freeze: freeze.frozen === true ? { frozen: true, frozenAt: freeze.frozenAt ?? updatedAt ?? publishedAt, reason: freeze.reason ?? "" } : { frozen: false },
    snapshots: [
      {
        releaseVersion,
        sourceCommit,
        buildId,
        publishedAt,
        manifestRef: "rly-release.json",
        artifacts: artifactDigests,
        qualification,
        state: "current",
      },
    ],
  };
}

/** Validates channel metadata shape. Returns sorted errors; empty = valid. */
export function validateChannelMetadata(metadata) {
  const errors = [];
  if (metadata === undefined || metadata === null || typeof metadata !== "object") return ["channel metadata is not an object"];
  if (metadata.channelSchemaVersion !== CHANNEL_METADATA_SCHEMA_VERSION) {
    errors.push(`channelSchemaVersion ${metadata.channelSchemaVersion ?? "(missing)"} != ${CHANNEL_METADATA_SCHEMA_VERSION}`);
  }
  if (!CHANNELS.includes(metadata.channel)) errors.push(`channel ${metadata.channel ?? "(missing)"} not beta|stable`);
  if (typeof metadata.version !== "number" || !Number.isInteger(metadata.version) || metadata.version <= 0) {
    errors.push("version must be a positive integer (monotonic counter)");
  }
  if (typeof metadata.updatedAt !== "string" || Number.isNaN(Date.parse(metadata.updatedAt))) errors.push("updatedAt invalid");
  if (metadata.staleness === undefined || typeof metadata.staleness.maxAgeDays !== "number" || metadata.staleness.maxAgeDays <= 0) {
    errors.push("staleness.maxAgeDays must be a positive number");
  }
  if (metadata.freeze === undefined || typeof metadata.freeze.frozen !== "boolean") errors.push("freeze.frozen must be a boolean");
  if (!Array.isArray(metadata.snapshots) || metadata.snapshots.length === 0) errors.push("snapshots must be a non-empty list");
  for (const snapshot of metadata.snapshots ?? []) {
    if (snapshot === null || typeof snapshot !== "object") {
      errors.push("snapshot is not an object");
      continue;
    }
    if (typeof snapshot.releaseVersion !== "string" || snapshot.releaseVersion.length === 0) errors.push("snapshot releaseVersion missing");
    if (snapshot.artifacts === undefined || typeof snapshot.artifacts !== "object" || Object.keys(snapshot.artifacts).length === 0) {
      errors.push(`snapshot ${snapshot.releaseVersion ?? "(?)"} artifacts map missing`);
    }
    for (const [target, artifact] of Object.entries(snapshot.artifacts ?? {})) {
      if (typeof artifact?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
        errors.push(`snapshot ${snapshot.releaseVersion ?? "(?)"} ${target} sha256 invalid`);
      }
      if (typeof artifact?.artifactDigest !== "string" || !/^[0-9a-f]{64}$/.test(artifact.artifactDigest)) {
        errors.push(`snapshot ${snapshot.releaseVersion ?? "(?)"} ${target} artifactDigest invalid`);
      }
    }
    const qualification = snapshot.qualification;
    if (qualification === undefined || !["qualified", "experimental-gaps", "not-qualified"].includes(qualification.status)) {
      errors.push(`snapshot ${snapshot.releaseVersion ?? "(?)"} qualification status invalid/missing`);
    }
  }
  return errors.sort();
}

/**
 * Evaluates channel metadata from an updater's point of view.
 * `observed` = { highestVersion, now } the client tracks. Returns a typed
 * result: { ok, errors, rollbackDetected, stale, frozen, ageDays }.
 * The updater must refuse when ok is false.
 */
export function evaluateChannelMetadata(metadata, { highestObservedVersion = 0, now = new Date().toISOString(), maxAgeDaysOverride } = {}) {
  const errors = [];
  const result = { ok: true, errors, rollbackDetected: false, stale: false, frozen: false, ageDays: null };

  if (metadata.version < highestObservedVersion) {
    result.rollbackDetected = true;
    errors.push(
      `rollback detected: metadata version ${metadata.version} < highest observed ${highestObservedVersion}; refusing to trust an older channel snapshot`,
    );
  }
  const maxAgeDays = maxAgeDaysOverride ?? metadata.staleness?.maxAgeDays ?? CHANNEL_MAX_AGE_DAYS;
  const ageMs = Date.parse(now) - Date.parse(metadata.updatedAt);
  if (Number.isNaN(ageMs)) {
    errors.push("cannot compute channel metadata age: updatedAt invalid");
  } else {
    result.ageDays = ageMs / 86_400_000;
    if (result.ageDays > maxAgeDays) {
      result.stale = true;
      errors.push(`channel metadata is stale: ${result.ageDays.toFixed(1)} days old > ${maxAgeDays} day window`);
    }
  }
  if (metadata.freeze?.frozen === true) {
    result.frozen = true;
    errors.push("channel is frozen; refusing to activate beyond the frozen snapshot");
  }
  result.ok = errors.length === 0;
  return result;
}

/**
 * The per-release qualification status a channel carries. Beta permits
 * documented experimental gaps; stable does not. Returns the machine-readable
 * status string recorded in channel metadata. Accepts the qualification
 * document shape ({ result: "qualified" | "experimental-gaps" | "not-qualified" })
 * or a plain { status } record.
 */
export function qualificationStatusForChannel(qualificationByTarget, channel) {
  const targets = Object.keys(qualificationByTarget).sort();
  if (targets.length === 0) return "not-qualified";
  const statusOf = (target) => qualificationByTarget[target]?.result ?? qualificationByTarget[target]?.status;
  if (channel === "stable") {
    const allQualified = targets.every((target) => statusOf(target) === "qualified");
    return allQualified ? "qualified" : "not-qualified";
  }
  const anyNotQualified = targets.some((target) => statusOf(target) === "not-qualified");
  if (anyNotQualified) return "not-qualified";
  const anyGaps = targets.some((target) => statusOf(target) === "experimental-gaps");
  return anyGaps ? "experimental-gaps" : "qualified";
}
