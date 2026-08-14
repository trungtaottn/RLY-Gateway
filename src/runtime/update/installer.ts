import { cp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDirectory, isNotFound } from "../../storage/private-files.js";
import {
  type CandidateInstallResult,
  type CandidateInstaller,
  type CandidateManifest,
  type CandidateVerification,
  type InstallCandidateInput,
} from "./types.js";

/**
 * Local candidate installer (#73, distribution-agnostic). The durable state
 * root owns a `runtime/` namespace where `current` and `previous` are symlinks
 * into versioned candidate directories:
 *
 *   <directory>/runtime/current -> versions/<version>
 *   <directory>/runtime/previous -> versions/<previous-version>
 *
 * Installing flips `current` and preserves `previous` as the rollback
 * reference; rollback flips back. The service definition re-registers the
 * entrypoint through the `current` symlink before the controlled restart.
 *
 * The signed/verified artifact download channel is #35 (BACKLOG); this
 * installer proves the lifecycle contract on a local verified candidate and
 * is replaced/backed by that channel without changing the state machine.
 */

const CANDIDATE_MANIFEST_NAME = "rly.json";

const candidateManifestSchema = z.object({
  product: z.literal("rly-gateway"),
  version: z.string().min(1),
  stateVersion: z.number().int().positive(),
  migrationForwardOnly: z.boolean(),
});

/** Reads and validates a candidate directory's manifest (undefined when absent/invalid). */
export async function readCandidateManifestFromDirectory(directory: string): Promise<CandidateManifest | undefined> {
  const manifest = await readJsonQuietly(join(directory, CANDIDATE_MANIFEST_NAME), candidateManifestSchema);
  return manifest === undefined
    ? undefined
    : {
        product: manifest.product,
        version: manifest.version,
        stateVersion: manifest.stateVersion,
        migrationForwardOnly: manifest.migrationForwardOnly,
      };
}

export type LocalCandidateInstallerOptions = Readonly<{
  /** Durable control-plane directory (owns the `runtime/` namespace). */
  directory: string;
  product?: string;
}>;

export class LocalCandidateInstaller implements CandidateInstaller {
  readonly #directory: string;
  readonly #product: string;

  public constructor(options: LocalCandidateInstallerOptions) {
    this.#directory = join(options.directory, "runtime");
    this.#product = options.product ?? "rly-gateway";
  }

  get currentPath(): string {
    return join(this.#directory, "current");
  }

  get previousPath(): string {
    return join(this.#directory, "previous");
  }

  get versionsDirectory(): string {
    return join(this.#directory, "versions");
  }

  public async installCandidate(input: InstallCandidateInput): Promise<CandidateInstallResult> {
    await ensurePrivateDirectory(this.#directory);
    await ensurePrivateDirectory(this.versionsDirectory);
    const target = join(this.versionsDirectory, input.version);
    await validateCandidateLayout(input.sourceDirectory);
    await rm(target, { recursive: true, force: true });
    await copyTree(input.sourceDirectory, target);
    // Preserve the previously selected version directory as the rollback
    // reference before flipping `current` to the new candidate.
    const previousTarget = await readlink(this.currentPath).catch(() => undefined);
    const previousVersion = previousTarget === undefined ? undefined : versionFromTarget(previousTarget);
    if (previousTarget === undefined) {
      await rm(this.previousPath, { force: true });
    } else {
      await swapLink(this.previousPath, previousTarget);
    }
    await swapLink(this.currentPath, target);
    return {
      version: input.version,
      ...(previousVersion === undefined ? {} : { previousVersion }),
    };
  }

  public async verifyCandidate(): Promise<CandidateVerification> {
    const version = await resolveVersion(this.currentPath);
    if (version === undefined) {
      return { ok: false, version: "none", reason: "no current candidate is selected" };
    }
    const manifest = await this.readManifest();
    if (manifest === undefined) {
      return { ok: false, version, reason: "candidate manifest is missing or malformed" };
    }
    if (manifest.product !== this.#product) {
      return { ok: false, version, reason: `candidate product is ${manifest.product}, not ${this.#product}` };
    }
    return { ok: true, version };
  }

  public async restorePrevious(): Promise<CandidateInstallResult> {
    const previousTarget = await readlink(this.previousPath).catch(() => undefined);
    if (previousTarget === undefined) {
      throw new Error("no previous known-good version is available for rollback");
    }
    const previousVersion = versionFromTarget(previousTarget);
    const currentTarget = await readlink(this.currentPath).catch(() => undefined);
    const restored = await swapLink(this.currentPath, previousTarget);
    if (!restored) throw new Error("rollback could not select the previous version");
    // Keep a rollback reference to the displaced candidate for diagnostics.
    if (currentTarget === undefined) {
      await rm(this.previousPath, { force: true });
    } else {
      await swapLink(this.previousPath, currentTarget);
    }
    return {
      version: previousVersion,
      ...(currentTarget === undefined ? {} : { previousVersion: versionFromTarget(currentTarget) }),
    };
  }

  public async readManifest(): Promise<CandidateManifest | undefined> {
    const version = await resolveVersion(this.currentPath);
    if (version === undefined) return undefined;
    const target = join(this.versionsDirectory, version);
    return readCandidateManifestFromDirectory(target);
  }
}

async function validateCandidateLayout(sourceDirectory: string): Promise<void> {
  const manifest = await readJsonQuietly(join(sourceDirectory, CANDIDATE_MANIFEST_NAME), candidateManifestSchema);
  if (manifest === undefined && !(await fileExists(join(sourceDirectory, "dist", "cli", "main.js")))) {
    throw new Error(
      `candidate ${sourceDirectory} is not a valid RLY runtime candidate: expected ${CANDIDATE_MANIFEST_NAME} or dist/cli/main.js`,
    );
  }
}

async function copyTree(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true, force: true });
}

async function swapLink(linkPath: string, target: string): Promise<boolean> {
  try {
    await rm(linkPath, { force: true });
    await symlink(target, linkPath);
    return true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return false;
  }
}

function versionFromTarget(target: string): string {
  return target.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown";
}

async function resolveVersion(linkPath: string): Promise<string | undefined> {
  const target = await readlink(linkPath).catch(() => undefined);
  return target === undefined ? undefined : versionFromTarget(target);
}

async function readJsonQuietly<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const parsed = schema.safeParse(JSON.parse(contents) as unknown);
  return parsed.success ? parsed.data : undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
