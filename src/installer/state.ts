import { join } from "node:path";
import {
  acquisitionLogEntrySchema,
  observedChannelsSchema,
  type AcquisitionLogEntry,
  type ObservedChannels,
  type ReleaseChannel,
} from "./types.js";
import {
  ensurePrivateDirectory,
  isNotFound,
  readPrivateTextIfPresent,
  writePrivateTextAtomically,
} from "../storage/private-files.js";

/**
 * Durable, secret-free installer/updater state (#129) under
 * `<control-plane>/installer/`:
 *
 *   observed-channels.json   highest observed per-channel metadata version
 *                            (rollback protection: a channel snapshot whose
 *                            monotonic version is lower than observed is
 *                            refused),
 *   acquisition-log.json     bounded append-only audit of acquisitions /
 *                            channel switches (channel, version, digest,
 *                            target, timestamps only).
 *
 * All records carry channel/version/build/digest/platform/path/status
 * metadata only — never credentials, tokens, prompts, responses, or account
 * identity.
 */

export const INSTALLER_STATE_DIRECTORY = "installer";
export const OBSERVED_CHANNELS_FILE = "observed-channels.json";
export const ACQUISITION_LOG_FILE = "acquisition-log.json";
export const MAX_ACQUISITION_LOG_ENTRIES = 100;

export class AcquisitionStateStore {
  readonly directory: string;
  readonly observedPath: string;
  readonly logPath: string;

  public constructor(controlPlaneDirectory: string) {
    this.directory = join(controlPlaneDirectory, INSTALLER_STATE_DIRECTORY);
    this.observedPath = join(this.directory, OBSERVED_CHANNELS_FILE);
    this.logPath = join(this.directory, ACQUISITION_LOG_FILE);
  }

  public async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
  }

  /** Reads observed per-channel versions; missing/malformed ⇒ none observed. */
  public async readObserved(): Promise<ObservedChannels> {
    await this.initialize();
    const contents = await readPrivateTextIfPresent(this.observedPath);
    if (contents === undefined) return { schemaVersion: 1, channels: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return { schemaVersion: 1, channels: {} };
    }
    const result = observedChannelsSchema.safeParse(parsed);
    if (!result.success) return { schemaVersion: 1, channels: {} };
    return result.data;
  }

  /** Returns the highest observed metadata version for a channel (0 = none). */
  public async highestObservedVersion(channel: ReleaseChannel): Promise<number> {
    const observed = await this.readObserved();
    return observed.channels[channel]?.highestVersion ?? 0;
  }

  /** Records a new highest observed metadata version for a channel. */
  public async recordObserved(channel: ReleaseChannel, metadataVersion: number): Promise<void> {
    await this.initialize();
    const observed = await this.readObserved();
    const current = observed.channels[channel];
    if (current !== undefined && current.highestVersion >= metadataVersion) return;
    const next: ObservedChannels = {
      schemaVersion: 1,
      channels: {
        ...observed.channels,
        [channel]: { highestVersion: metadataVersion, updatedAt: new Date().toISOString() },
      },
    };
    await writePrivateTextAtomically(this.observedPath, `${JSON.stringify(next)}\n`);
  }

  /** Appends a secret-free acquisition-log record (bounded history). */
  public async appendAcquisition(entry: AcquisitionLogEntry): Promise<void> {
    acquisitionLogEntrySchema.parse(entry);
    await this.initialize();
    const current = await this.readLog();
    const next = [...current, entry].slice(-MAX_ACQUISITION_LOG_ENTRIES);
    await writePrivateTextAtomically(this.logPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  /** Reads the bounded acquisition log (secret-free, fail-closed on malformed). */
  public async readLog(): Promise<readonly AcquisitionLogEntry[]> {
    await this.initialize();
    const contents = await readPrivateTextIfPresent(this.logPath);
    if (contents === undefined) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const entries: AcquisitionLogEntry[] = [];
    for (const entry of parsed) {
      const result = acquisitionLogEntrySchema.safeParse(entry);
      if (result.success) entries.push(result.data);
    }
    return entries;
  }

  /** Removes the installer state namespace (uninstall artifact cleanup). */
  public async removeState(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(this.directory, { recursive: true, force: true }).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });
  }
}
