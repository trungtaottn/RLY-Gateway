import { join } from "node:path";
import { claimKeyHash, CLAIM_SCHEMA_VERSION, CLAIM_FEATURE_VALUES } from "../canary/claim.js";
import type { ClaimFeature } from "../canary/claim.js";
import {
  ensurePrivateDirectory,
  isNotFound,
  listPrivateDirectory,
  readPrivateTextIfPresent,
  writePrivateTextAtomically,
} from "../storage/private-files.js";
import { nextDecisionRevision } from "./review.js";
import { nextQuarantineRevision } from "./quarantine.js";
import type { QuarantineRecord, ReviewDecision } from "./types.js";
import { z } from "zod";

/**
 * Durable Review Decision + Negative Quarantine stores (#124).
 *
 * Secret-free metadata-only records (reviewer/source/reason/timestamp/
 * revision — never credentials, account identity, prompts, responses, or
 * reasoning text) persist under `<control-plane>/compat/reviews/` and
 * `<control-plane>/compat/quarantines/` (0700 dirs / 0600 atomic files).
 * Append/audit-friendly: existing records are never rewritten; a new decision
 * or quarantine appends with a monotonic revision. Reads are schema-validated
 * and fail closed on malformed documents.
 */

export const COMPAT_SCHEMA_VERSION = 1 as const;
const COMPAT_DIRECTORY = "compat";
const REVIEWS_DIRECTORY = "reviews";
const QUARANTINES_DIRECTORY = "quarantines";

export const REVIEW_SOURCE = "rly-compat-review" as const;
export const QUARANTINE_SOURCE = "rly-compat-quarantine" as const;

// ---------------------------------------------------------------------------
// Zod persistence schemas (fail-closed reads)
// ---------------------------------------------------------------------------

export const reviewDecisionSchema = z.object({
  claimKey: z.string().min(1),
  feature: z.enum(CLAIM_FEATURE_VALUES),
  decision: z.enum(["promote", "reject"]),
  evidenceRevision: z.string().min(1),
  reviewer: z.string().min(1),
  source: z.string().min(1),
  reason: z.string().min(1),
  decidedAt: z.string().min(1),
  decisionRevision: z.number().int().positive(),
  rlyBuildVersion: z.string().optional(),
});

export const quarantineRecordSchema = z.object({
  claimKey: z.string().min(1),
  feature: z.enum(CLAIM_FEATURE_VALUES),
  reason: z.string().min(1),
  source: z.string().min(1),
  quarantinedAt: z.string().min(1),
  quarantineRevision: z.number().int().positive(),
  rlyBuildVersion: z.string().optional(),
  liftedAt: z.string().optional(),
  liftedBy: z.string().optional(),
  liftReason: z.string().optional(),
});

const reviewDocumentSchema = z.object({
  schemaVersion: z.literal(COMPAT_SCHEMA_VERSION),
  claimKey: z.string().min(1),
  feature: z.enum(CLAIM_FEATURE_VALUES),
  decisions: z.array(reviewDecisionSchema),
});

const quarantineDocumentSchema = z.object({
  schemaVersion: z.literal(COMPAT_SCHEMA_VERSION),
  claimKey: z.string().min(1),
  feature: z.enum(CLAIM_FEATURE_VALUES),
  records: z.array(quarantineRecordSchema),
});

function storeDirectory(controlPlaneDirectory: string, subdirectory: string): string {
  return join(controlPlaneDirectory, COMPAT_DIRECTORY, subdirectory);
}

function documentPath(directory: string, claimKey: string, feature: string): string {
  return join(directory, `${claimKeyHash(claimKey)}-${feature}.json`);
}

/** Writes one review-decision document (append semantics preserved by caller). */
async function writeReviewDocument(
  directory: string,
  claimKey: string,
  feature: string,
  decisions: readonly ReviewDecision[],
): Promise<string> {
  await ensurePrivateDirectory(directory);
  const path = documentPath(directory, claimKey, feature);
  await writePrivateTextAtomically(path, JSON.stringify({
    schemaVersion: COMPAT_SCHEMA_VERSION,
    claimKey,
    feature,
    decisions: Object.freeze([...decisions]),
  }, null, 2));
  return path;
}

/** Writes one quarantine document (append semantics preserved by caller). */
async function writeQuarantineDocument(
  directory: string,
  claimKey: string,
  feature: string,
  records: readonly QuarantineRecord[],
): Promise<string> {
  await ensurePrivateDirectory(directory);
  const path = documentPath(directory, claimKey, feature);
  await writePrivateTextAtomically(path, JSON.stringify({
    schemaVersion: COMPAT_SCHEMA_VERSION,
    claimKey,
    feature,
    records: Object.freeze([...records]),
  }, null, 2));
  return path;
}

function parseReviews(claimKey: string, feature: string, content: string | undefined): readonly ReviewDecision[] {
  if (content === undefined) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Malformed review decision artifact for ${claimKey}|${feature}`);
  }
  try {
    const doc = reviewDocumentSchema.parse(parsed);
    return Object.freeze(doc.decisions.map((decision) => cleanOptional<ReviewDecision>(decision as unknown as Record<string, unknown>)));
  } catch {
    throw new Error(`Malformed review decision artifact for ${claimKey}|${feature}`);
  }
}

function parseQuarantines(claimKey: string, feature: string, content: string | undefined): readonly QuarantineRecord[] {
  if (content === undefined) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Malformed quarantine artifact for ${claimKey}|${feature}`);
  }
  try {
    const doc = quarantineDocumentSchema.parse(parsed);
    return Object.freeze(doc.records.map((record) => cleanOptional<QuarantineRecord>(record as unknown as Record<string, unknown>)));
  } catch {
    throw new Error(`Malformed quarantine artifact for ${claimKey}|${feature}`);
  }
}

/** Drops `undefined` optional keys so records satisfy exact-optional typing. */
function cleanOptional<T extends object>(value: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/**
 * Durable Review Decision Store (#124). Explicit promotion/rejection tied to
 * exact claim identities + evidence revisions. Positive trust requires an
 * explicit reviewed decision — a new PASS observation never auto-promotes.
 */
export class ReviewDecisionStore {
  public constructor(private readonly controlPlaneDirectory: string) {}

  private directory(): string {
    return storeDirectory(this.controlPlaneDirectory, REVIEWS_DIRECTORY);
  }

  /** Appends one decision; returns the persisted document path. */
  public async addDecision(
    input: Readonly<Omit<ReviewDecision, "decisionRevision">>,
  ): Promise<Readonly<{ decision: ReviewDecision; path: string }>> {
    const existing = await this.decisionsFor(input.claimKey, input.feature);
    const decision: ReviewDecision = Object.freeze({
      ...input,
      decisionRevision: nextDecisionRevision(existing),
    });
    const path = await writeReviewDocument(this.directory(), input.claimKey, input.feature, [...existing, decision]);
    return Object.freeze({ decision, path });
  }

  /** All decisions for one (claimKey, feature), oldest → newest. */
  public async decisionsFor(claimKey: string, feature: string): Promise<readonly ReviewDecision[]> {
    const content = await readPrivateTextIfPresent(documentPath(this.directory(), claimKey, feature));
    return parseReviews(claimKey, feature, content);
  }

  /** All persisted decisions across the store (deterministic: sorted by path). */
  public async listDecisions(): Promise<readonly ReviewDecision[]> {
    const directory = this.directory();
    let names: string[];
    try {
      names = (await listPrivateDirectory(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (isNotFound(error)) return Object.freeze([]);
      throw error;
    }
    const all: ReviewDecision[] = [];
    for (const name of names) {
      const content = await readPrivateTextIfPresent(join(directory, name));
      if (content === undefined) continue;
      all.push(...parseReviews(name, "", content));
    }
    return Object.freeze(all);
  }

  /** Secret-free summary for diagnostics (counts + schema only). */
  public async summary(): Promise<Readonly<{ schemaVersion: number; decisionCount: number; promoteCount: number; rejectCount: number }>> {
    const decisions = await this.listDecisions();
    return Object.freeze({
      schemaVersion: COMPAT_SCHEMA_VERSION,
      decisionCount: decisions.length,
      promoteCount: decisions.filter((decision) => decision.decision === "promote").length,
      rejectCount: decisions.filter((decision) => decision.decision === "reject").length,
    });
  }
}

/**
 * Durable Negative Quarantine Store (#124). A strong reproducible failure can
 * quarantine an exact claim/path/feature promptly; scope is narrow by keying,
 * quarantine never deletes historical evidence, and an explicit lift restores
 * evaluation.
 */
export class QuarantineStore {
  public constructor(private readonly controlPlaneDirectory: string) {}

  private directory(): string {
    return storeDirectory(this.controlPlaneDirectory, QUARANTINES_DIRECTORY);
  }

  /** Quarantines one exact claim/feature; returns the persisted record + path. */
  public async quarantine(
    input: Readonly<Omit<QuarantineRecord, "quarantineRevision" | "liftedAt" | "liftedBy" | "liftReason">>,
  ): Promise<Readonly<{ record: QuarantineRecord; path: string }>> {
    const existing = await this.recordsFor(input.claimKey, input.feature);
    const record: QuarantineRecord = Object.freeze({
      ...input,
      quarantineRevision: nextQuarantineRevision(existing),
    });
    const path = await writeQuarantineDocument(this.directory(), input.claimKey, input.feature, [...existing, record]);
    return Object.freeze({ record, path });
  }

  /** Explicitly lifts the active quarantine for one claim/feature (audit-friendly). */
  public async lift(
    claimKey: string,
    feature: string,
    input: Readonly<{ by: string; reason: string }>,
  ): Promise<Readonly<{ record: QuarantineRecord; path: string }>> {
    const existing = await this.recordsFor(claimKey, feature);
    const active = existing.reduce<QuarantineRecord | undefined>(
      (latest, record) => record.liftedAt === undefined
        && (latest === undefined || record.quarantineRevision > latest.quarantineRevision)
        ? record
        : latest,
      undefined,
    );
    if (active === undefined) {
      throw new Error(`No active quarantine to lift for ${claimKey}|${feature}`);
    }
    const lifted: QuarantineRecord = Object.freeze({
      ...active,
      liftedAt: new Date().toISOString(),
      liftedBy: input.by,
      liftReason: input.reason,
    });
    const records = existing.map((record) => record.quarantineRevision === active.quarantineRevision ? lifted : record);
    const path = await writeQuarantineDocument(this.directory(), claimKey, feature, records);
    return Object.freeze({ record: lifted, path });
  }

  /** All quarantine records for one (claimKey, feature), oldest → newest. */
  public async recordsFor(claimKey: string, feature: string): Promise<readonly QuarantineRecord[]> {
    const content = await readPrivateTextIfPresent(documentPath(this.directory(), claimKey, feature));
    return parseQuarantines(claimKey, feature, content);
  }

  /** All persisted quarantine records across the store (deterministic sort). */
  public async listRecords(): Promise<readonly QuarantineRecord[]> {
    const directory = this.directory();
    let names: string[];
    try {
      names = (await listPrivateDirectory(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (isNotFound(error)) return Object.freeze([]);
      throw error;
    }
    const all: QuarantineRecord[] = [];
    for (const name of names) {
      const content = await readPrivateTextIfPresent(join(directory, name));
      if (content === undefined) continue;
      all.push(...parseQuarantines(name, "", content));
    }
    return Object.freeze(all);
  }

  /** Secret-free summary for diagnostics (counts only). */
  public async summary(): Promise<Readonly<{ schemaVersion: number; recordCount: number; activeCount: number }>> {
    const records = await this.listRecords();
    return Object.freeze({
      schemaVersion: COMPAT_SCHEMA_VERSION,
      recordCount: records.length,
      activeCount: records.filter((record) => record.liftedAt === undefined).length,
    });
  }
}

// Re-exported for consumers that want the canonical feature union alongside
// the stores without a separate import path.
export type { ClaimFeature };

export { CLAIM_SCHEMA_VERSION };
