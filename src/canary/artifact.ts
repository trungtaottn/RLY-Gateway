import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  isNotFound,
  listPrivateDirectory,
  readPrivateTextIfPresent,
  writePrivateTextAtomically,
} from "../storage/private-files.js";
import type { CanaryEvidence, CanaryRunSummary } from "./types.js";

/**
 * Persists secret-free canary evidence artifacts (#24). Artifacts live under
 * `<control-plane>/canary/*.json`, are metadata-only (client/provider/model
 * ids, gate names, status, fixture revision — never prompts, responses,
 * reasoning text, credentials, or account identity), and are consumable by the
 * #23/#67 review workflow. They never mutate trusted registry evidence, and a
 * malformed artifact fails closed on read.
 */

const CANARY_DIRECTORY = "canary";

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
      summaries.push(parsed as CanaryRunSummary);
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
