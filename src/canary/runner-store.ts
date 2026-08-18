import { join } from "node:path";
import {
  ensurePrivateDirectory,
  isNotFound,
  listPrivateDirectory,
  readPrivateTextIfPresent,
  writePrivateTextAtomically,
} from "../storage/private-files.js";

/**
 * Raw runner-result store (#123). Layer B/C runner summaries that carry more
 * than a single evidence record (allowlisted wire metadata, per-gate timing,
 * typed reasons) persist under `<control-plane>/canary-runners/` as metadata
 * only — never credentials, authorization headers, account identity, prompts,
 * real responses, or reasoning text. `ref` fields on Evidence Artifact v2
 * records point here (path, never content). The trusted registry and the
 * append/audit claim store are never mutated by runner results.
 */

const RUNNER_RESULTS_DIRECTORY = "canary-runners";

export class RunnerResultStore {
  public constructor(private readonly controlPlaneDirectory: string) {}

  private directory(): string {
    return join(this.controlPlaneDirectory, RUNNER_RESULTS_DIRECTORY);
  }

  /** Atomically persists one runner's raw machine-readable results. */
  public async write(name: string, payload: unknown): Promise<string> {
    await ensurePrivateDirectory(this.directory());
    const path = join(this.directory(), `${name}.json`);
    await writePrivateTextAtomically(path, JSON.stringify(payload, null, 2));
    return path;
  }

  /** Reads one raw result file (metadata only; secret-free by construction). */
  public async read(path: string): Promise<string | undefined> {
    return readPrivateTextIfPresent(path);
  }

  /** Lists persisted runner result files deterministically. */
  public async list(): Promise<readonly string[]> {
    try {
      return Object.freeze((await listPrivateDirectory(this.directory())).filter((name) => name.endsWith(".json")).sort());
    } catch (error) {
      if (isNotFound(error)) return Object.freeze([]);
      throw error;
    }
  }
}
