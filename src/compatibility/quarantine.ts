import type { QuarantineRecord } from "./types.js";

/**
 * Negative Quarantine Store — pure logic (#124).
 *
 * A strong reproducible failure can quarantine an EXACT claim/path/feature
 * promptly per documented policy. Scope is inherently narrow: records are
 * keyed to the exact claim key, so one provider/model/feature failure never
 * poisons unrelated paths or features. Quarantine is separate from deleting
 * historical trusted evidence — evidence documents are never touched.
 */

/** Latest quarantine record (highest revision); lifted records are inactive. */
export function latestQuarantine(records: readonly QuarantineRecord[]): QuarantineRecord | undefined {
  return records.reduce<QuarantineRecord | undefined>(
    (latest, record) => record.liftedAt === undefined
      && (latest === undefined || record.quarantineRevision > latest.quarantineRevision)
      ? record
      : latest,
    undefined,
  );
}

/** True when an active (non-lifted) quarantine exists for the exact claim. */
export function isQuarantined(records: readonly QuarantineRecord[]): boolean {
  return latestQuarantine(records) !== undefined;
}

/** Next monotonic quarantine revision for a (claimKey, feature) history. */
export function nextQuarantineRevision(records: readonly QuarantineRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.quarantineRevision), 0) + 1;
}
