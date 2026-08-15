import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  isNotFound,
  listPrivateDirectory,
  readPrivateTextIfPresent,
  writePrivateTextAtomically,
} from "../storage/private-files.js"
import {
  CLAIM_SCHEMA_VERSION,
  LEGACY_V1_POLICY,
  appendObservation,
  claimKeyFor,
  claimKeyHash,
  compatibilityClaimDocumentSchema,
  emptyClaimDocument,
  isV2EvidenceSummary,
  type ClaimFeature,
  type CompatibilityClaimDocument,
  type CompatibilityClaimIdentity,
  type EvidenceArtifactV2,
} from "./claim.js";
import type { CanaryEvidence, CanaryRunSummary } from "./types.js";

/**
 * Persists secret-free canary evidence artifacts (#24, evidence v2 by #122).
 * Artifacts live under `<control-plane>/canary/*.json` (run summaries) and
 * `<control-plane>/claims/*.json` (feature-scoped Compatibility Claim
 * documents). Both are metadata-only (client/provider/model ids, claim keys,
 * layer, gate names, status, fixture revision — never prompts, responses,
 * reasoning text, credentials, or account identity) and consumable by the
 * #23/#67 review workflow. They never mutate trusted registry evidence, and a
 * malformed artifact fails closed on read.
 *
 * Legacy policy (#122): pre-v2 canary summaries (no `evidenceSchemaVersion`)
 * remain readable for diagnostics but are marked legacy/untrusted for v2
 * authority decisions — they can never satisfy a v2 claim (`ClaimEvidenceStore`
 * never reads them), and a claim lookup returns `missing` until a v2
 * observation records real evidence.
 */

const CANARY_DIRECTORY = "canary";
const CLAIM_DIRECTORY = "claims";

export class CanaryStore {
  public constructor(private readonly controlPlaneDirectory: string) {}

  private canaryDirectory(): string {
    return join(this.controlPlaneDirectory, CANARY_DIRECTORY);
  }

  /** Atomically persists one canary run's evidence summary. Returns the artifact path. */
  public async write(summary: CanaryRunSummary): Promise<string> {
    const directory = this.canaryDirectory();
    await ensurePrivateDirectory(directory);
    const path = join(directory, `canary-${summary.clientBaseline}.json`);
    await writePrivateTextAtomically(path, JSON.stringify(summary, null, 2));
    return path;
  }

  /**
   * Lists persisted canary artifacts deterministically (sorted by name).
   * Malformed artifacts fail closed: a file that no longer parses is a
   * local-state integrity error, not silently skipped or trusted.
   */
  public async list(): Promise<readonly CanaryRunSummary[]> {
    const directory = this.canaryDirectory();
    let names: string[];
    try {
      names = (await listPrivateDirectory(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (isNotFound(error)) return Object.freeze([]);
      throw error;
    }
    const summaries: CanaryRunSummary[] = [];
    for (const name of names) {
      const path = join(directory, name);
      const content = await readPrivateTextIfPresent(path);
      if (content === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(`Malformed canary artifact: ${name}`);
      }
      const candidate = parsed as Readonly<{ clientBaseline?: unknown }>;
      if (parsed === null || typeof parsed !== "object" || typeof candidate.clientBaseline !== "string") {
        throw new Error(`Malformed canary artifact: ${name}`);
      }
      const summary = parsed as CanaryRunSummary;
      // #122 legacy policy: pre-v2 artifacts stay readable but are flagged
      // legacy/untrusted for v2 authority decisions.
      if (!isV2EvidenceSummary(parsed)) {
        summaries.push(Object.freeze({ ...summary, legacy: true, legacyReason: LEGACY_V1_POLICY }));
        continue;
      }
      summaries.push(summary);
    }
    return Object.freeze(summaries);
  }

  /** Reads one named artifact raw (for review/proposal tooling). */
  public async read(path: string): Promise<string | undefined> {
    return readPrivateTextIfPresent(path);
  }

  /** Loads a reviewable canary artifact for tests/tooling. */
  public static async load(path: string): Promise<readonly CanaryEvidence[]> {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as unknown;
    const candidate = parsed as Readonly<{ results?: unknown }>;
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(candidate.results)) {
      throw new Error("Malformed canary artifact");
    }
    return candidate.results as readonly CanaryEvidence[];
  }
}

/**
 * Claim/evidence v2 persistence (#122).
 *
 * Append/audit-friendly: one JSON document per feature-scoped claim key under
 * `<control-plane>/claims/<claimKeyHash>.json`. A new observation is appended
 * to the claim document (atomic temp+rename writes, `0700` dir / `0600`
 * files); existing records are never modified or silently rewritten. Reads are
 * schema-validated and fail closed on malformed documents.
 */
export class ClaimEvidenceStore {
  public constructor(private readonly controlPlaneDirectory: string) {}

  private claimsDirectory(): string {
    return join(this.controlPlaneDirectory, CLAIM_DIRECTORY);
  }

  private pathFor(claimKey: string): string {
    return join(this.claimsDirectory(), `claim-${claimKeyHash(claimKey)}.json`);
  }

  /** Appends one run's claim observations (idempotent per identical record). */
  public async appendRun(summary: CanaryRunSummary, options?: Readonly<{ ref?: string }>): Promise<void> {
    for (const claim of summary.claims ?? []) {
      let doc = await this.loadClaim(claim.claimKey) ?? emptyClaimDocument(claim.claimIdentity, claim.feature);
      for (const record of claim.records) {
        const withRef: EvidenceArtifactV2 = options?.ref === undefined
          ? record
          : Object.freeze({ ...record, ref: options.ref });
        doc = appendObservation(doc, withRef);
      }
      await this.writeClaim(doc);
    }
  }

  /** Writes one claim document atomically (append semantics preserved by caller). */
  public async writeClaim(doc: CompatibilityClaimDocument): Promise<string> {
    await ensurePrivateDirectory(this.claimsDirectory());
    const path = this.pathFor(doc.claimKey);
    await writePrivateTextAtomically(path, JSON.stringify(doc, null, 2));
    return path;
  }

  /** Deterministic lookup by exact claim identity + feature (#122). */
  public async findEvidence(
    claimIdentity: CompatibilityClaimIdentity,
    feature: ClaimFeature,
  ): Promise<CompatibilityClaimDocument | undefined> {
    return this.loadClaim(claimKeyFor(claimIdentity, feature));
  }

  /** Loads one claim document by its canonical key; malformed docs fail closed. */
  public async loadClaim(claimKey: string): Promise<CompatibilityClaimDocument | undefined> {
    const content = await readPrivateTextIfPresent(this.pathFor(claimKey));
    if (content === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Malformed claim evidence artifact for key ${claimKey}`);
    }
    try {
      return compatibilityClaimDocumentSchema.parse(parsed) as CompatibilityClaimDocument;
    } catch {
      throw new Error(`Malformed claim evidence artifact for key ${claimKey}`);
    }
  }

  /** Lists all persisted claim documents (deterministic: sorted by claim key). */
  public async listClaims(): Promise<readonly CompatibilityClaimDocument[]> {
    const directory = this.claimsDirectory();
    let names: string[];
    try {
      names = (await listPrivateDirectory(directory)).filter((name) => name.startsWith("claim-") && name.endsWith(".json")).sort();
    } catch (error) {
      if (isNotFound(error)) return Object.freeze([]);
      throw error;
    }
    const claims: CompatibilityClaimDocument[] = [];
    for (const name of names) {
      const content = await readPrivateTextIfPresent(join(directory, name));
      if (content === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error(`Malformed claim evidence artifact: ${name}`);
      }
      try {
        claims.push(compatibilityClaimDocumentSchema.parse(parsed) as CompatibilityClaimDocument);
      } catch {
        throw new Error(`Malformed claim evidence artifact: ${name}`);
      }
    }
    return Object.freeze(claims);
  }

  /** Secret-free status summary for diagnostics (schema version + counts only). */
  public async summary(): Promise<Readonly<{
    schemaVersion: number;
    claimCount: number;
    recordCount: number;
    legacyPolicy: string;
  }>> {
    const claims = await this.listClaims();
    return Object.freeze({
      schemaVersion: CLAIM_SCHEMA_VERSION,
      claimCount: claims.length,
      recordCount: claims.reduce((count, claim) => count + claim.records.length, 0),
      legacyPolicy: LEGACY_V1_POLICY,
    });
  }
}
