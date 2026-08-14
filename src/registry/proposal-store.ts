import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  isNotFound,
  listPrivateDirectory,
  readPrivateTextIfPresent,
  writePrivateTextAtomically,
} from "../storage/private-files.js";
import {
  catalogProposalReportSchema,
  discoverySnapshotSchema,
  type CatalogProposalReport,
} from "./catalog-proposal.js";
import type { DiscoverySnapshot } from "./model-registry.js";

/**
 * Persists proposed catalog candidates SEPARATE from trusted evidence (#23).
 *
 * Artifacts live under `<control-plane-directory>/proposals/<providerId>.json`,
 * are metadata-only (no credentials/identity), schema-validated fail-closed on
 * read, and are never consumed as trusted `ModelEvidence`. Promotion to the
 * trusted #67 registry is a separate reviewed operation.
 */

const PROPOSALS_DIRECTORY = "proposals";

export class ProposalStore {
  public constructor(private readonly controlPlaneDirectory: string) {}

  private proposalsDirectory(): string {
    return join(this.controlPlaneDirectory, PROPOSALS_DIRECTORY);
  }

  /** Atomically persists one provider's proposal report. Returns the artifact path. */
  public async write(report: CatalogProposalReport): Promise<string> {
    const directory = this.proposalsDirectory();
    await ensurePrivateDirectory(directory);
    const path = join(directory, `${report.providerId}.json`);
    await writePrivateTextAtomically(path, JSON.stringify(report, null, 2));
    return path;
  }

  /**
   * Lists persisted proposals deterministically (sorted by providerId).
   * Malformed artifacts fail closed: a file that no longer validates is a
   * local-state integrity error, not silently skipped or trusted.
   */
  public async list(): Promise<readonly CatalogProposalReport[]> {
    const directory = this.proposalsDirectory();
    let names: string[];
    try {
      names = (await listPrivateDirectory(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if (isNotFound(error)) return Object.freeze([]);
      throw error;
    }
    const reports: CatalogProposalReport[] = [];
    for (const name of names) {
      const path = join(directory, name);
      const text = await readPrivateTextIfPresent(path);
      if (text === undefined) continue;
      const parsed = catalogProposalReportSchema.safeParse(JSON.parse(text) as unknown);
      if (!parsed.success) {
        throw new Error(`proposal artifact failed schema validation: ${path}`);
      }
      reports.push(parsed.data as unknown as CatalogProposalReport);
    }
    return Object.freeze(reports);
  }

  /** Reads one provider's persisted proposal, if present. */
  public async read(providerId: string): Promise<CatalogProposalReport | undefined> {
    const path = join(this.proposalsDirectory(), `${providerId}.json`);
    const text = await readPrivateTextIfPresent(path);
    if (text === undefined) return undefined;
    const parsed = catalogProposalReportSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) {
      throw new Error(`proposal artifact failed schema validation: ${path}`);
    }
    return parsed.data as unknown as CatalogProposalReport;
  }
}

export async function readDiscoverySnapshotFile(path: string): Promise<DiscoverySnapshot> {
  const text = await readFile(path, "utf8");
  const parsed = discoverySnapshotSchema.safeParse(JSON.parse(text) as unknown);
  if (!parsed.success) {
    throw new Error(`discovery snapshot failed schema validation: ${path}`);
  }
  return parsed.data as unknown as DiscoverySnapshot;
}
