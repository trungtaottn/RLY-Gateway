import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, lstat, readFile, readdir, readlink, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  currentUid,
  ensurePrivateDirectory,
  fsyncPrivateDirectory,
  isAlreadyExists,
  isNotFound,
  PRIVATE_DIRECTORY_MODE,
  readPrivateSymlinkTarget,
  removePrivateSymlinkIfPresent,
  replacePrivateSymlinkAtomically,
  writePrivateTextAtomically,
} from "../../storage/private-files.js";
import { runtimePaths } from "../../storage/paths.js";
import {
  artifactIdSchema,
  DEPLOYMENT_METADATA_FILE_NAME,
  deploymentMetadataSchema,
  migrationClassSchema,
  type CandidateInstallResult,
  type CandidateInstaller,
  type CandidateManifest,
  type CandidateVerification,
  type DeploymentMetadata,
  type InstallCandidateInput,
} from "./types.js";

/**
 * Local candidate installer (#73, distribution-agnostic; immutable store and
 * atomic references #92). The durable state root owns a `runtime/` namespace:
 *
 *   <directory>/runtime/versions/<artifactId>/   immutable deployments
 *   <directory>/runtime/refs/staged              -> ../versions/<artifactId>
 *   <directory>/runtime/refs/active              -> ../versions/<artifactId>
 *   <directory>/runtime/refs/previous            -> ../versions/<artifactId>
 *
 * - Artifact identity is a SHA-256 over the exact candidate tree bytes, so
 *   byte-distinct candidates always receive distinct identities and semantic
 *   version is metadata only (never the directory key).
 * - A successfully installed immutable deployment is never recursively
 *   replaced; reinstalling the identical artifact is an idempotent no-write.
 * - Installing a candidate updates ONLY `staged`; the serving `active`
 *   reference is switched by the explicit `activateStaged()` activation
 *   transition (#93 will own the transactional gate) and restored by
 *   `restorePrevious()`.
 * - Reference changes are temp-reference create + atomic rename + parent
 *   directory fsync, never `rm + symlink`, so readers observe either the old
 *   valid reference or the new valid reference, never a gap.
 * - Legacy `runtime/current`/`previous` + `versions/<semver>` layouts migrate
 *   in place without deleting a serving runtime before the new ref state is
 *   durable; malformed legacy state fails closed with an actionable recovery.
 *
 * The signed/verified artifact download channel is #35 (BACKLOG); this
 * installer proves the lifecycle contract on a local verified candidate and
 * is replaced/backed by that channel without changing the state machine.
 */

const CANDIDATE_MANIFEST_NAME = "rly.json";
const STAGING_PREFIX = ".staging-";
const REF_TARGET_PREFIX = "../versions/";

const candidateManifestSchema = z.object({
  product: z.literal("rly-gateway"),
  version: z.string().min(1),
  stateVersion: z.number().int().positive(),
  migrationForwardOnly: z.boolean().optional(),
  migrationClass: migrationClassSchema.optional(),
  // Exact build identity (#94) of the release candidate.
  buildId: z.string().min(1).optional(),
  commitRevision: z.string().min(1).optional(),
  releaseChannel: z.enum(["dev", "beta", "stable"]).optional(),
  controlProtocolVersion: z.number().int().positive().optional(),
  dataProtocolVersion: z.number().int().positive().optional(),
});

const legacyMigrationMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  /** `migrating` = planned mappings recorded but refs not yet durable. */
  state: z.enum(["migrating", "committed"]),
  migratedAt: z.iso.datetime(),
  /** planned legacy-name → artifact-id mappings (identifiers only). */
  mappings: z.array(z.object({ legacyName: z.string().min(1), artifactId: artifactIdSchema })),
});

type LegacyMigrationMarker = z.infer<typeof legacyMigrationMarkerSchema>;

export class DeploymentStoreError extends Error {
  override name = "DeploymentStoreError";
}

/** Reads and validates a candidate directory's manifest (undefined when absent/invalid). */
export async function readCandidateManifestFromDirectory(directory: string): Promise<CandidateManifest | undefined> {
  const manifest = await readJsonQuietly(join(directory, CANDIDATE_MANIFEST_NAME), candidateManifestSchema);
  return manifest === undefined
    ? undefined
    : {
        product: manifest.product,
        version: manifest.version,
        stateVersion: manifest.stateVersion,
        ...(manifest.migrationClass === undefined ? {} : { migrationClass: manifest.migrationClass }),
        ...(manifest.migrationForwardOnly === undefined ? {} : { migrationForwardOnly: manifest.migrationForwardOnly }),
        ...(manifest.buildId === undefined ? {} : { buildId: manifest.buildId }),
        ...(manifest.commitRevision === undefined ? {} : { commitRevision: manifest.commitRevision }),
        ...(manifest.releaseChannel === undefined ? {} : { releaseChannel: manifest.releaseChannel }),
        ...(manifest.controlProtocolVersion === undefined ? {} : { controlProtocolVersion: manifest.controlProtocolVersion }),
        ...(manifest.dataProtocolVersion === undefined ? {} : { dataProtocolVersion: manifest.dataProtocolVersion }),
      };
}

export type LocalCandidateInstallerOptions = Readonly<{
  /** Durable control-plane directory (owns the `runtime/` namespace). */
  directory: string;
  product?: string;
  /** Test seam: injectable tree copy (defaults to node fs `cp`). */
  copyTree?: (source: string, target: string) => Promise<void>;
}>;

type ResolvedRef = Readonly<{ artifactId: string; version: string }>;

export class LocalCandidateInstaller implements CandidateInstaller {
  readonly #directory: string;
  readonly #product: string;
  readonly #copyTree: (source: string, target: string) => Promise<void>;

  public constructor(options: LocalCandidateInstallerOptions) {
    // `options.directory` is the durable control-plane directory that owns the
    // `runtime/` namespace; `runtimePaths()` appends the `runtime` segment.
    this.#directory = options.directory;
    this.#product = options.product ?? "rly-gateway";
    this.#copyTree = options.copyTree ?? copyTree;
  }

  get runtimeDirectory(): string {
    return runtimePaths(this.#directory).runtime;
  }

  get versionsDirectory(): string {
    return runtimePaths(this.#directory).versions;
  }

  get refsDirectory(): string {
    return runtimePaths(this.#directory).refs;
  }

  get stagedPath(): string {
    return runtimePaths(this.#directory).staged;
  }

  get activePath(): string {
    return runtimePaths(this.#directory).active;
  }

  get previousPath(): string {
    return runtimePaths(this.#directory).previous;
  }

  /**
   * Stages a verified candidate as an immutable deployment and points
   * `refs/staged` at it. Never touches `refs/active`/`refs/previous`
   * (INSTALL != ACTIVATE, #92). Reinstalling the exact same artifact is
   * idempotent and does not rewrite immutable contents; byte-distinct
   * candidates with the same semantic version get distinct artifact ids.
   */
  public async installCandidate(input: InstallCandidateInput): Promise<CandidateInstallResult> {
    await this.#ensureRuntimeLayout();
    await validateCandidateLayout(input.sourceDirectory);
    const artifactId = await computeArtifactId(input.sourceDirectory);
    const target = join(this.versionsDirectory, artifactId);
    if (!(await isRealDirectory(target))) {
      const staging = join(this.versionsDirectory, `${STAGING_PREFIX}${randomUUID()}`);
      try {
        await this.#copyTree(input.sourceDirectory, staging);
        await chmod(staging, PRIVATE_DIRECTORY_MODE);
        const manifest = await readCandidateManifestFromDirectory(input.sourceDirectory);
        const metadata: DeploymentMetadata = {
          schemaVersion: 1,
          artifactId,
          product: this.#product,
          version: manifest?.version ?? input.version,
          ...(manifest === undefined ? {} : { stateVersion: manifest.stateVersion }),
          ...(manifest === undefined ? {} : { migrationForwardOnly: manifest.migrationForwardOnly }),
          ...(manifest === undefined ? {} : { migrationClass: manifest.migrationClass }),
          ...(manifest === undefined ? {} : { buildId: manifest.buildId }),
          ...(manifest === undefined ? {} : { commitRevision: manifest.commitRevision }),
          ...(manifest === undefined ? {} : { releaseChannel: manifest.releaseChannel }),
          installedAt: new Date().toISOString(),
        };
        await writePrivateTextAtomically(join(staging, DEPLOYMENT_METADATA_FILE_NAME), `${JSON.stringify(metadata)}\n`);
        await fsyncPrivateDirectory(staging);
        try {
          await rename(staging, target);
        } catch (error: unknown) {
          if (!isAlreadyExists(error)) throw error;
          // A concurrent identical install won the rename; reuse it.
        }
        await fsyncPrivateDirectory(this.versionsDirectory);
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    // Validate the completed deployment layout BEFORE exposing it via a ref.
    const metadata = await this.#validateDeployment(target, artifactId);
    await replacePrivateSymlinkAtomically(this.stagedPath, refTarget(artifactId));
    const active = await this.#resolveRef(this.activePath);
    return {
      version: metadata.version,
      artifactId,
      ...(active === undefined ? {} : { previousVersion: active.version, previousArtifactId: active.artifactId }),
    };
  }

  public async verifyCandidate(): Promise<CandidateVerification> {
    await this.#ensureRuntimeLayout();
    const staged = await this.#resolveRef(this.stagedPath);
    if (staged === undefined) {
      return { ok: false, version: "none", reason: "no staged candidate is selected" };
    }
    let metadata: DeploymentMetadata;
    try {
      metadata = await this.#validateDeployment(join(this.versionsDirectory, staged.artifactId), staged.artifactId);
    } catch (error: unknown) {
      return { ok: false, version: staged.version, reason: `staged candidate deployment is missing or malformed: ${errorMessage(error)}; run rly doctor` };
    }
    if (metadata.product !== this.#product) {
      return { ok: false, version: staged.version, reason: `candidate product is ${metadata.product}, not ${this.#product}` };
    }
    return { ok: true, version: staged.version, artifactId: staged.artifactId };
  }

  /**
   * Activation transition primitive: atomically switches `refs/active` to the
   * staged deployment and preserves the displaced deployment as
   * `refs/previous`. #93 owns the transactional drain/fence/probation gate
   * around this primitive; here it is the atomic ref switch itself. The
   * `previous` reference is established BEFORE the `active` switch so a crash
   * between the two atomic renames never loses the known-good reference.
   */
  public async activateStaged(): Promise<CandidateInstallResult> {
    await this.#ensureRuntimeLayout();
    const staged = await this.#resolveRef(this.stagedPath);
    if (staged === undefined) {
      throw new DeploymentStoreError("no staged candidate is available to activate; re-run rly update");
    }
    const active = await this.#resolveRef(this.activePath);
    if (active !== undefined && active.artifactId === staged.artifactId) {
      return { version: staged.version, artifactId: staged.artifactId, previousVersion: active.version, previousArtifactId: active.artifactId };
    }
    if (active === undefined) {
      // Nothing serving: record no previous, then switch active to staged.
      await removePrivateSymlinkIfPresent(this.previousPath);
    } else {
      // Crash-safe order (#93): the displaced known-good becomes `previous`
      // BEFORE `active` switches, so a crash between the two renames leaves
      // active still serving the known-good and previous pointing at it.
      await replacePrivateSymlinkAtomically(this.previousPath, refTarget(active.artifactId));
    }
    await replacePrivateSymlinkAtomically(this.activePath, refTarget(staged.artifactId));
    return {
      version: staged.version,
      artifactId: staged.artifactId,
      ...(active === undefined ? {} : { previousVersion: active.version, previousArtifactId: active.artifactId }),
    };
  }

  /**
   * #93 crash recovery: re-establishes `refs/active` (and `refs/previous`)
   * deterministically from durable transaction-journal evidence. Both targets
   * must be validated immutable deployments; previous is written before active
   * so the known-good reference is never lost mid-recovery. Idempotent: a
   * crash during recovery re-applies the same refs.
   */
  public async setActiveReferences(input: Readonly<{ activeArtifactId: string; previousArtifactId?: string }>): Promise<void> {
    await this.#ensureRuntimeLayout();
    await this.#validateDeployment(join(this.versionsDirectory, input.activeArtifactId), input.activeArtifactId);
    if (input.previousArtifactId !== undefined) {
      await this.#validateDeployment(join(this.versionsDirectory, input.previousArtifactId), input.previousArtifactId);
      await replacePrivateSymlinkAtomically(this.previousPath, refTarget(input.previousArtifactId));
    } else {
      await removePrivateSymlinkIfPresent(this.previousPath);
    }
    await replacePrivateSymlinkAtomically(this.activePath, refTarget(input.activeArtifactId));
  }

  public async restorePrevious(): Promise<CandidateInstallResult> {
    await this.#ensureRuntimeLayout();
    const previous = await this.#resolveRef(this.previousPath);
    if (previous === undefined) {
      throw new DeploymentStoreError("no previous known-good version is available for rollback");
    }
    const active = await this.#resolveRef(this.activePath);
    await replacePrivateSymlinkAtomically(this.activePath, refTarget(previous.artifactId));
    if (active === undefined) {
      await removePrivateSymlinkIfPresent(this.previousPath);
    } else {
      await replacePrivateSymlinkAtomically(this.previousPath, refTarget(active.artifactId));
    }
    return {
      version: previous.version,
      artifactId: previous.artifactId,
      ...(active === undefined ? {} : { previousVersion: active.version, previousArtifactId: active.artifactId }),
    };
  }

  public async readManifest(): Promise<CandidateManifest | undefined> {
    await this.#ensureRuntimeLayout();
    const staged = await this.#resolveRef(this.stagedPath);
    if (staged === undefined) return undefined;
    return readCandidateManifestFromDirectory(join(this.versionsDirectory, staged.artifactId));
  }

  async #ensureRuntimeLayout(): Promise<void> {
    const paths = runtimePaths(this.#directory);
    await ensurePrivateDirectory(paths.runtime);
    await ensurePrivateDirectory(paths.versions);
    await ensurePrivateDirectory(paths.refs);
    await this.#migrateLegacyLayout();
    await this.#cleanStaleStaging();
  }

  async #migrateLegacyLayout(): Promise<void> {
    const paths = runtimePaths(this.#directory);
    const marker = await readMigrationMarker(paths.migrationMarker);
    const legacyCurrent = await readLegacySymlink(join(paths.runtime, "current"));
    const legacyPrevious = await readLegacySymlink(join(paths.runtime, "previous"));
    if (marker?.state === "committed") {
      // Refs are durable; only stale legacy pointers/duplicates may remain.
      await removeLegacySymlinkIfPresent(join(paths.runtime, "current"));
      await removeLegacySymlinkIfPresent(join(paths.runtime, "previous"));
      await this.#removeDuplicateLegacyDirectories();
      return;
    }
    const legacyNames = await listLegacyVersionDirectories(paths.versions);
    if (legacyCurrent === undefined && legacyPrevious === undefined && legacyNames.length === 0) {
      // No legacy layout at all: record the committed marker so future runs
      // never rescan, and never touch references that may already exist.
      await writeMigrationMarker(paths.migrationMarker, { state: "committed", mappings: [] });
      return;
    }
    // Recover (or plan) the legacy → artifact mapping. A crash between marker
    // write and rename/ref creation is re-applied idempotently from the
    // durable `migrating` marker; the legacy bytes are only ever renamed,
    // never deleted, until the ref state is durable and committed.
    const planned = marker?.state === "migrating"
      ? marker.mappings
      : await planLegacyMappings(paths.versions, legacyNames);
    const legacyToArtifact = new Map(planned.map((entry) => [entry.legacyName, entry.artifactId] as const));
    // Resolve the legacy serving references to artifact ids BEFORE any rename,
    // so unknown/malformed legacy state fails closed without mutating bytes.
    const activeId = legacyCurrent === undefined
      ? undefined
      : resolveLegacyTarget(legacyCurrent, legacyToArtifact);
    if (legacyCurrent !== undefined && activeId === undefined) {
      throw new DeploymentStoreError(
        `legacy runtime/current points at an unknown or missing deployment (${legacyCurrent}); refusing to migrate without a known serving runtime. Run rly doctor`,
      );
    }
    if (legacyCurrent === undefined && !(await hasValidRef(paths.active))) {
      throw new DeploymentStoreError(
        "legacy runtime layout has no current reference and no valid active reference; refusing to guess the serving runtime. Run rly doctor",
      );
    }
    const previousId = legacyPrevious === undefined
      ? undefined
      : resolveLegacyTarget(legacyPrevious, legacyToArtifact);
    if (legacyPrevious !== undefined && previousId === undefined) {
      throw new DeploymentStoreError(
        `legacy runtime/previous points at an unknown or missing deployment (${legacyPrevious}); run rly doctor`,
      );
    }
    if (marker?.state !== "migrating") {
      await writeMigrationMarker(paths.migrationMarker, { state: "migrating", mappings: planned });
    }
    for (const entry of planned) {
      const from = join(paths.versions, entry.legacyName);
      const to = join(paths.versions, entry.artifactId);
      if (await isRealDirectory(to)) {
        // Already migrated (crash retry): backfill store-owned deployment
        // metadata if absent; leave any legacy duplicate in place until the
        // commit point, then remove it as a verified duplicate.
        await this.#ensureDeploymentMetadata(to, entry.artifactId, entry.legacyName);
        continue;
      }
      if (!(await isRealDirectory(from))) {
        throw new DeploymentStoreError(
          `legacy deployment ${entry.legacyName} is missing during runtime migration; run rly doctor to recover the last known-good runtime`,
        );
      }
      await chmod(from, PRIVATE_DIRECTORY_MODE);
      await rename(from, to);
      await this.#ensureDeploymentMetadata(to, entry.artifactId, entry.legacyName);
    }
    await fsyncPrivateDirectory(paths.versions);

    // Establish refs from the legacy serving references (or reuse already
    // valid refs from a crash retry). The serving deployment is only ever
    // renamed (bytes preserved), never deleted, before this point is durable.
    if (activeId !== undefined) {
      await this.#ensureRef(paths.active, activeId);
    }
    if (previousId !== undefined) {
      await this.#ensureRef(paths.previous, previousId);
    }
    await fsyncPrivateDirectory(paths.refs);

    // Durable commit point: refs + marker committed before ANY legacy removal.
    await writeMigrationMarker(paths.migrationMarker, { state: "committed", mappings: planned });
    await fsyncPrivateDirectory(paths.runtime);
    await removeLegacySymlinkIfPresent(join(paths.runtime, "current"));
    await removeLegacySymlinkIfPresent(join(paths.runtime, "previous"));
    await this.#removeDuplicateLegacyDirectories();
    await fsyncPrivateDirectory(paths.runtime);
  }

  /** Creates a ref only when absent/invalid-in-target; validates before use. */
  async #ensureRef(refPath: string, artifactId: string): Promise<void> {
    const existing = await this.#resolveRef(refPath).catch(() => undefined);
    if (existing !== undefined) {
      if (existing.artifactId !== artifactId) {
        throw new DeploymentStoreError(
          `reference ${basename(refPath)} already points at a different immutable deployment (${existing.artifactId}); refusing to overwrite. Run rly doctor`,
        );
      }
      return;
    }
    await replacePrivateSymlinkAtomically(refPath, refTarget(artifactId));
  }

  /**
   * Writes store-owned immutable deployment metadata into a deployment that
   * lacks it (legacy-migrated deployments), one-time only and never
   * overwriting an existing record. Identity/version/digest identifiers only.
   */
  async #ensureDeploymentMetadata(directory: string, artifactId: string, fallbackVersion: string): Promise<void> {
    const existing = await readJsonQuietly(join(directory, DEPLOYMENT_METADATA_FILE_NAME), deploymentMetadataSchema);
    if (existing !== undefined) {
      if (existing.artifactId !== artifactId) {
        throw new DeploymentStoreError(
          `deployment metadata identity ${existing.artifactId} conflicts with its directory ${artifactId}; run rly doctor`,
        );
      }
      return;
    }
    const manifest = await readCandidateManifestFromDirectory(directory);
    const metadata: DeploymentMetadata = {
      schemaVersion: 1,
      artifactId,
      product: this.#product,
      version: manifest?.version ?? fallbackVersion,
      ...(manifest === undefined ? {} : { stateVersion: manifest.stateVersion }),
      ...(manifest === undefined ? {} : { migrationForwardOnly: manifest.migrationForwardOnly }),
      ...(manifest === undefined ? {} : { migrationClass: manifest.migrationClass }),
      ...(manifest === undefined ? {} : { buildId: manifest.buildId }),
      ...(manifest === undefined ? {} : { commitRevision: manifest.commitRevision }),
      ...(manifest === undefined ? {} : { releaseChannel: manifest.releaseChannel }),
      installedAt: new Date().toISOString(),
    };
    await writePrivateTextAtomically(join(directory, DEPLOYMENT_METADATA_FILE_NAME), `${JSON.stringify(metadata)}\n`);
    await fsyncPrivateDirectory(directory);
  }

  async #removeDuplicateLegacyDirectories(): Promise<void> {
    const paths = runtimePaths(this.#directory);
    for (const name of await listLegacyVersionDirectories(paths.versions)) {
      const artifactId = await computeArtifactId(join(paths.versions, name)).catch(() => undefined);
      if (artifactId === undefined) {
        throw new DeploymentStoreError(
          `legacy deployment ${name} could not be hashed during cleanup; run rly doctor before removing it`,
        );
      }
      if (await isRealDirectory(join(paths.versions, artifactId))) {
        // The immutable deployment is durable; the legacy duplicate is safe
        // to remove now (identical bytes by construction).
        await rm(join(paths.versions, name), { recursive: true, force: true });
      }
    }
  }

  async #cleanStaleStaging(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(runtimePaths(this.#directory).versions);
    } catch (error: unknown) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const name of names) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      const path = join(runtimePaths(this.#directory).versions, name);
      const details = await lstat(path).catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (details === undefined || !details.isDirectory() || details.isSymbolicLink()) continue;
      await rm(path, { recursive: true, force: true });
    }
  }

  /**
   * Resolves a reference symlink to a validated immutable deployment. Missing
   * ⇒ undefined; a malformed target fails closed with an actionable error.
   */
  async #resolveRef(refPath: string): Promise<ResolvedRef | undefined> {
    const target = await readPrivateSymlinkTarget(refPath);
    if (target === undefined) return undefined;
    const resolved = join(dirname(refPath), target);
    if (dirname(resolved) !== this.versionsDirectory) {
      throw new DeploymentStoreError(`reference ${basename(refPath)} escapes the immutable store (${target}); run rly doctor`);
    }
    const artifactId = basename(resolved);
    if (!artifactIdSchema.safeParse(artifactId).success) {
      throw new DeploymentStoreError(`reference ${basename(refPath)} points at a non-immutable name (${target}); run rly doctor`);
    }
    const metadata = await this.#validateDeployment(resolved, artifactId);
    return { artifactId, version: metadata.version };
  }

  /** Validates a completed deployment layout before it may be referenced. */
  async #validateDeployment(directory: string, expectedArtifactId: string): Promise<DeploymentMetadata> {
    const details = await lstat(directory).catch((error: unknown) => {
      if (isNotFound(error)) {
        throw new DeploymentStoreError(`deployment is missing: ${directory}; run rly update to re-install or rly doctor`);
      }
      throw error;
    });
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new DeploymentStoreError(`deployment is not a real directory: ${directory}; run rly doctor`);
    }
    if (details.uid !== currentUid() || (details.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw new DeploymentStoreError(`deployment directory must be current-user private (0700): ${directory}; run rly doctor`);
    }
    const metadata = await readDeploymentMetadata(directory);
    if (metadata.artifactId !== expectedArtifactId) {
      throw new DeploymentStoreError(
        `deployment metadata identity ${metadata.artifactId} does not match its directory ${expectedArtifactId}; run rly doctor`,
      );
    }
    const manifest = await readCandidateManifestFromDirectory(directory);
    const hasEntrypoint = await fileExists(join(directory, "dist", "cli", "main.js"));
    if (manifest === undefined && !hasEntrypoint) {
      throw new DeploymentStoreError(`deployment layout is incomplete (no ${CANDIDATE_MANIFEST_NAME} or dist/cli/main.js): ${directory}; run rly doctor`);
    }
    return metadata;
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

/**
 * Computes the immutable artifact identity of a candidate tree: SHA-256 over
 * sorted relative paths + file contents. Symlinks and special files fail
 * closed (deployments are private and must be self-contained, and the digest
 * must be deterministic).
 */
export async function computeArtifactId(sourceDirectory: string): Promise<string> {
  const entries = await treeFileDigests(sourceDirectory);
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.sha256}\0`);
  }
  return hash.digest("hex");
}

async function treeFileDigests(root: string, relative = ""): Promise<ReadonlyArray<{ path: string; sha256: string }>> {
  const directory = relative ? join(root, relative) : root;
  const names = await readdir(directory, { withFileTypes: true });
  const entries: Array<{ path: string; sha256: string }> = [];
  for (const name of names.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryRelative = relative ? join(relative, name.name) : name.name;
    if (name.isSymbolicLink()) {
      throw new DeploymentStoreError(`candidate contains a symlink; refusing non-self-contained deployment: ${entryRelative}`);
    }
    if (name.isDirectory()) {
      entries.push(...await treeFileDigests(root, entryRelative));
      continue;
    }
    if (!name.isFile()) {
      throw new DeploymentStoreError(`candidate contains a non-file entry; refusing deployment: ${entryRelative}`);
    }
    const contents = await readFile(join(root, entryRelative));
    entries.push({ path: entryRelative, sha256: createHash("sha256").update(contents).digest("hex") });
  }
  return entries;
}

async function copyTree(source: string, target: string): Promise<void> {
  await cp(source, target, { recursive: true, force: true });
}

function refTarget(artifactId: string): string {
  return `${REF_TARGET_PREFIX}${artifactId}`;
}

async function readDeploymentMetadata(directory: string): Promise<DeploymentMetadata> {
  const metadata = await readJsonQuietly(join(directory, DEPLOYMENT_METADATA_FILE_NAME), deploymentMetadataSchema);
  if (metadata === undefined) {
    throw new DeploymentStoreError(`deployment metadata is missing or malformed: ${join(directory, DEPLOYMENT_METADATA_FILE_NAME)}; run rly doctor`);
  }
  return metadata;
}

async function readMigrationMarker(path: string): Promise<LegacyMigrationMarker | undefined> {
  return readJsonQuietly(path, legacyMigrationMarkerSchema);
}

async function writeMigrationMarker(path: string, input: Readonly<{ state: "migrating" | "committed"; mappings: readonly LegacyMigrationMarker["mappings"][number][] }>): Promise<void> {
  const marker: LegacyMigrationMarker = {
    schemaVersion: 1,
    state: input.state,
    migratedAt: new Date().toISOString(),
    mappings: [...input.mappings],
  };
  await writePrivateTextAtomically(path, `${JSON.stringify(marker)}\n`);
}

/** Lists `versions/` entries that are not valid artifact ids (legacy semver dirs). */
async function listLegacyVersionDirectories(versionsDirectory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(versionsDirectory);
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return names.filter((name) => !artifactIdSchema.safeParse(name).success).sort();
}

async function planLegacyMappings(
  versionsDirectory: string,
  legacyNames: readonly string[],
): Promise<Array<{ legacyName: string; artifactId: string }>> {
  const planned: Array<{ legacyName: string; artifactId: string }> = [];
  for (const name of legacyNames) {
    planned.push({ legacyName: name, artifactId: await computeArtifactId(join(versionsDirectory, name)) });
  }
  return planned;
}

/** Resolves a legacy `current`/`previous` symlink target to an artifact id. */
function resolveLegacyTarget(
  target: string,
  legacyToArtifact: ReadonlyMap<string, string>,
): string | undefined {
  const segments = target.split(/[\\/]/).filter(Boolean);
  const name = segments.at(-1);
  if (name === undefined) return undefined;
  const mapped = legacyToArtifact.get(name);
  if (mapped !== undefined) return mapped;
  return artifactIdSchema.safeParse(name).success ? name : undefined;
}

async function readLegacySymlink(path: string): Promise<string | undefined> {
  let details;
  try {
    details = await lstat(path);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (!details.isSymbolicLink()) {
    throw new DeploymentStoreError(`legacy ${path} is not a symlink; refusing to migrate a malformed runtime layout. Run rly doctor`);
  }
  return readlink(path);
}

async function removeLegacySymlinkIfPresent(path: string): Promise<void> {
  await removePrivateSymlinkIfPresent(path).catch((error: unknown) => {
    if (!isNotFound(error)) throw error;
  });
}

async function hasValidRef(refPath: string): Promise<boolean> {
  try {
    return await readPrivateSymlinkTarget(refPath) !== undefined;
  } catch {
    return false;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isDirectory() && !details.isSymbolicLink();
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw error;
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
