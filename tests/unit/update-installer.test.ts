import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeploymentStoreError,
  LocalCandidateInstaller,
  computeArtifactId,
  readCandidateManifestFromDirectory,
} from "../../src/runtime/update/installer.js";
import { DEPLOYMENT_METADATA_FILE_NAME, type CandidateManifest } from "../../src/runtime/update/types.js";
import { artifactIdSchema } from "../../src/runtime/update/types.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-gateway-update-install-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function candidateDirectory(root: string, version: string, bytes: string, manifest: Partial<CandidateManifest> = {}): Promise<string> {
  const source = join(root, `candidate-${version}`);
  await mkdir(join(source, "dist", "cli"), { recursive: true });
  await writeFile(join(source, "dist", "cli", "main.js"), bytes, "utf8");
  await writeFile(join(source, "rly.json"), `${JSON.stringify({
    product: "rly-gateway",
    version,
    stateVersion: 2,
    migrationForwardOnly: false,
    ...manifest,
  })}\n`, "utf8");
  return source;
}

/** Builds a legacy semver layout exactly as the pre-#92 installer left it. */
async function legacyLayout(root: string, versions: ReadonlyArray<{ version: string; bytes: string }>): Promise<{ versions: string }> {
  const runtime = join(root, "runtime");
  const versionsDir = join(runtime, "versions");
  await mkdir(versionsDir, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  for (const entry of versions) {
    const dir = join(versionsDir, entry.version);
    await mkdir(join(dir, "dist", "cli"), { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await chmod(join(dir, "dist"), 0o700);
    await chmod(join(dir, "dist", "cli"), 0o700);
    await writeFile(join(dir, "dist", "cli", "main.js"), entry.bytes, "utf8");
    await writeFile(join(dir, "rly.json"), `${JSON.stringify({
      product: "rly-gateway",
      version: entry.version,
      stateVersion: 2,
      migrationForwardOnly: false,
    })}\n`, "utf8");
  }
  return { versions: versionsDir };
}

async function link(runtime: string, name: string, target: string): Promise<void> {
  await symlink(target, join(runtime, name));
}

async function listDeployments(installer: LocalCandidateInstaller): Promise<string[]> {
  return (await readdir(installer.versionsDirectory)).filter((name) => artifactIdSchema.safeParse(name).success);
}

describe("immutable deployment store (#92)", () => {
  it("stages a candidate under a content-addressed artifact id and never touches the serving active reference", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "2.0.0", "// rly 2.0.0\n");
    const installed = await installer.installCandidate({ version: "2.0.0", sourceDirectory: source });

    const expected = await computeArtifactId(source);
    expect(installed.artifactId).toBe(expected);
    expect(installed.version).toBe("2.0.0");
    expect(installed.previousVersion).toBeUndefined();

    // The deployment is stored under the artifact digest, never the semver.
    const deployments = await listDeployments(installer);
    expect(deployments).toEqual([expected]);
    await expect(stat(join(installer.versionsDirectory, "2.0.0"))).rejects.toThrow();

    // staged points at it; active/previous do not exist (nothing serving).
    expect(await readlink(installer.stagedPath)).toBe(`../versions/${expected}`);
    await expect(readlink(installer.activePath)).rejects.toThrow();
    await expect(readlink(installer.previousPath)).rejects.toThrow();
  });

  it("reinstalling the exact same artifact is idempotent and does not rewrite immutable contents", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "2.0.0", "// rly 2.0.0\n");
    const first = await installer.installCandidate({ version: "2.0.0", sourceDirectory: source });
    const target = join(installer.versionsDirectory, first.artifactId);

    const before = await readFile(join(target, "dist", "cli", "main.js"), "utf8");
    const second = await installer.installCandidate({ version: "2.0.0", sourceDirectory: source });

    expect(second.artifactId).toBe(first.artifactId);
    expect(second.version).toBe("2.0.0");
    expect(await listDeployments(installer)).toEqual([first.artifactId]);
    expect(await readFile(join(target, "dist", "cli", "main.js"), "utf8")).toBe(before);
    expect(await readlink(installer.stagedPath)).toBe(`../versions/${first.artifactId}`);
  });

  it("two byte-distinct candidates with the same semantic version never alias one deployment directory", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });

    const sourceA = await candidateDirectory(root, "2.0.0-a", "// bytes A\n", { version: "2.0.0" });
    const sourceB = await candidateDirectory(root, "2.0.0-b", "// bytes B\n", { version: "2.0.0" });
    const first = await installer.installCandidate({ version: "2.0.0", sourceDirectory: sourceA });
    const second = await installer.installCandidate({ version: "2.0.0", sourceDirectory: sourceB });

    expect(first.artifactId).not.toBe(second.artifactId);
    expect(first.version).toBe("2.0.0");
    expect(second.version).toBe("2.0.0");
    // Both immutable deployments coexist under distinct artifact ids.
    expect(await listDeployments(installer)).toEqual(expect.arrayContaining([first.artifactId, second.artifactId]));
    expect(await readlink(installer.stagedPath)).toBe(`../versions/${second.artifactId}`);
    // Re-staging the first artifact is still idempotent; no alias is created.
    const third = await installer.installCandidate({ version: "2.0.0", sourceDirectory: sourceA });
    expect(third.artifactId).toBe(first.artifactId);
    expect(await listDeployments(installer)).toEqual(expect.arrayContaining([first.artifactId, second.artifactId]));
    expect(await readlink(installer.stagedPath)).toBe(`../versions/${first.artifactId}`);
  });

  it("an interrupted copy never exposes a partial deployment as staged or active, and stale staging is cleaned", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const source = await candidateDirectory(root, "2.0.0", "// rly 2.0.0\n");
    const failing = new LocalCandidateInstaller({
      directory: stateRoot,
      // eslint-disable-next-line @typescript-eslint/require-await
      copyTree: async () => { throw new Error("simulated interrupted copy"); },
    });
    await expect(failing.installCandidate({ version: "2.0.0", sourceDirectory: source })).rejects.toThrow("simulated interrupted copy");
    expect(await listDeployments(failing)).toEqual([]);
    await expect(readlink(failing.stagedPath)).rejects.toThrow();
    await expect(readlink(failing.activePath)).rejects.toThrow();

    // A healthy installer reuses the same store: no partial deployment is
    // ever visible and leftover staging directories are removed.
    const healthy = new LocalCandidateInstaller({ directory: stateRoot });
    const installed = await healthy.installCandidate({ version: "2.0.0", sourceDirectory: source });
    expect(installed.artifactId).toBe(await computeArtifactId(source));
    const stagingLeftovers = (await readdir(healthy.versionsDirectory)).filter((name) => name.startsWith(".staging-"));
    expect(stagingLeftovers).toEqual([]);
    expect((await healthy.verifyCandidate()).ok).toBe(true);
  });

  it("an interrupted ref switch keeps the previous valid reference and stale temp references are cleaned", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const sourceA = await candidateDirectory(root, "2.0.0", "// bytes A\n");
    const sourceB = await candidateDirectory(root, "2.1.0", "// bytes B\n");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: sourceA });

    // Simulate a crash between temp-reference creation and rename: a stale
    // `.staged.<uuid>.tmp` symlink is left behind. The staged ref itself is
    // untouched by that window and still resolves to the old valid target.
    const staleTemp = join(installer.refsDirectory, `.staged.00000000-0000-4000-8000-000000000001.tmp`);
    await symlink("../versions/does-not-exist", staleTemp);
    expect(await readlink(installer.stagedPath)).toMatch(/^\.\.\/versions\/[0-9a-f]{64}$/);
    const before = await readlink(installer.stagedPath);

    // The next atomic replace cleans the stale temp and points at the new
    // deployment; the ref never disappears in between.
    await installer.installCandidate({ version: "2.1.0", sourceDirectory: sourceB });
    expect(await readlink(installer.stagedPath)).not.toBe(before);
    const temps = (await readdir(installer.refsDirectory)).filter((name) => name.includes(".tmp"));
    expect(temps).toEqual([]);
  });

  it("readers observe only the old or the new valid reference during rapid replacement, never a gap", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const sourceA = await candidateDirectory(root, "2.0.0", "// bytes A\n");
    const sourceB = await candidateDirectory(root, "2.1.0", "// bytes B\n");
    const [artifactIdA, artifactIdB] = await Promise.all([
      computeArtifactId(sourceA),
      computeArtifactId(sourceB),
    ]);
    // Prime the staged reference so the reader never observes a pre-install
    // missing-ref window (that window is not an atomic-replace gap).
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: sourceA });

    const replacements = (async () => {
      for (let index = 0; index < 12; index += 1) {
        await installer.installCandidate({ version: index % 2 === 0 ? "2.0.0" : "2.1.0", sourceDirectory: index % 2 === 0 ? sourceA : sourceB });
      }
    })();
    const reader = (async () => {
      let observed = 0;
      while (observed < 250) {
        const target = await readlink(installer.stagedPath).catch(() => undefined);
        if (target === undefined) {
          throw new Error(`reader observed a missing staged reference (gap)`);
        }
        const match = /^\.\.\/versions\/([0-9a-f]{64})$/.exec(target);
        if (match === null) {
          throw new Error(`reader observed an invalid reference: ${target}`);
        }
        if (match[1] !== artifactIdA && match[1] !== artifactIdB) {
          throw new Error(`reader observed a foreign reference: ${target}`);
        }
        observed += 1;
      }
    })();
    await Promise.all([replacements, reader]);
  });

  it("verifyCandidate and readManifest operate on the staged deployment only", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    expect((await installer.verifyCandidate()).ok).toBe(false);
    expect(await installer.readManifest()).toBeUndefined();

    const source = await candidateDirectory(root, "2.0.0", "// rly 2.0.0\n", { migrationForwardOnly: true, stateVersion: 3 });
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: source });
    const verified = await installer.verifyCandidate();
    expect(verified.ok).toBe(true);
    expect(verified.version).toBe("2.0.0");
    expect(await installer.readManifest()).toMatchObject({ product: "rly-gateway", version: "2.0.0", stateVersion: 3, migrationForwardOnly: true });
    expect(await readCandidateManifestFromDirectory(source)).toMatchObject({ version: "2.0.0", stateVersion: 3, migrationForwardOnly: true });
  });

  it("activateStaged switches active atomically and restorePrevious flips back, refusing without references", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    await expect(installer.restorePrevious()).rejects.toThrow(/no previous known-good/);

    const sourceV1 = await candidateDirectory(root, "1.0.0", "// v1\n");
    const installed1 = await installer.installCandidate({ version: "1.0.0", sourceDirectory: sourceV1 });
    expect(installed1.previousVersion).toBeUndefined();

    // Installation never activates: active is absent until activation.
    await expect(readlink(installer.activePath)).rejects.toThrow();
    const activated1 = await installer.activateStaged();
    expect(activated1.version).toBe("1.0.0");
    expect(await readlink(installer.activePath)).toBe(`../versions/${activated1.artifactId}`);
    await expect(readlink(installer.previousPath)).rejects.toThrow();

    // Staging 2.0.0 leaves active untouched.
    const sourceV2 = await candidateDirectory(root, "2.0.0", "// v2\n");
    const installed2 = await installer.installCandidate({ version: "2.0.0", sourceDirectory: sourceV2 });
    expect(installed2.previousVersion).toBe("1.0.0");
    expect(installed2.previousArtifactId).toBe(activated1.artifactId);
    expect(await readlink(installer.activePath)).toBe(`../versions/${activated1.artifactId}`);

    // Activation preserves the displaced deployment as previous.
    const activated2 = await installer.activateStaged();
    expect(activated2.version).toBe("2.0.0");
    expect(await readlink(installer.activePath)).toBe(`../versions/${activated2.artifactId}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${activated1.artifactId}`);

    // Rollback restores the previous known-good and keeps the displaced one.
    const restored = await installer.restorePrevious();
    expect(restored.version).toBe("1.0.0");
    expect(await readlink(installer.activePath)).toBe(`../versions/${activated1.artifactId}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${activated2.artifactId}`);
  });

  it("activateStaged records the displaced known-good as previous BEFORE switching active (#93 crash safety)", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const sourceV1 = await candidateDirectory(root, "1.0.0", "// v1\n");
    await installer.installCandidate({ version: "1.0.0", sourceDirectory: sourceV1 });
    await installer.activateStaged();
    const id1 = await computeArtifactId(sourceV1);
    const sourceV2 = await candidateDirectory(root, "2.0.0", "// v2\n");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: sourceV2 });
    const id2 = await computeArtifactId(sourceV2);

    // Simulate the crash window BETWEEN the previous write and the active
    // switch (the installer writes previous first): active still serves the
    // known-good and previous points at the same known-good — never lost.
    const { replacePrivateSymlinkAtomically, removePrivateSymlinkIfPresent } = await import("../../src/storage/private-files.js");
    const refTarget = (id: string): string => `../versions/${id}`;
    await removePrivateSymlinkIfPresent(installer.previousPath).catch(() => undefined);
    await replacePrivateSymlinkAtomically(installer.previousPath, refTarget(id1));
    expect(await readlink(installer.activePath)).toBe(refTarget(id1));
    expect(await readlink(installer.previousPath)).toBe(refTarget(id1));

    // The journal-driven recovery primitive re-establishes refs from durable
    // evidence: active ← known-good, previous ← aborted candidate (idempotent).
    await installer.setActiveReferences({ activeArtifactId: id1, previousArtifactId: id2 });
    expect(await readlink(installer.activePath)).toBe(refTarget(id1));
    expect(await readlink(installer.previousPath)).toBe(refTarget(id2));

    // Re-applying the same recovery refs is idempotent (crash during recovery).
    await installer.setActiveReferences({ activeArtifactId: id1, previousArtifactId: id2 });
    expect(await readlink(installer.activePath)).toBe(refTarget(id1));
    expect(await readlink(installer.previousPath)).toBe(refTarget(id2));

    // Recovery refuses unknown/missing deployments (fail closed).
    await expect(installer.setActiveReferences({ activeArtifactId: "f".repeat(64) })).rejects.toThrow(/deployment is missing/);
  });
});

describe("content-addressed identity with preserved pnpm symlinks (#144)", () => {
  let sourceSerial = 0;

  /** Builds a two-level pnpm-style source tree (fastify→avvio structure). */
  async function pnpmSource(root: string, bytes = "// v1\n"): Promise<string> {
    sourceSerial += 1;
    const source = join(root, `candidate-symlink-${sourceSerial}`);
    await mkdir(join(source, "dist", "cli"), { recursive: true });
    await writeFile(join(source, "dist", "cli", "main.js"), bytes, "utf8");
    await writeFile(join(source, "rly.json"), `${JSON.stringify({ product: "rly-gateway", version: "1.0.0", stateVersion: 2, migrationForwardOnly: false })}\n`, "utf8");
    await mkdir(join(source, "node_modules", ".pnpm", "app@1", "node_modules", "app"), { recursive: true });
    await mkdir(join(source, "node_modules", ".pnpm", "dep@1", "node_modules", "dep"), { recursive: true });
    await writeFile(join(source, "node_modules", ".pnpm", "app@1", "node_modules", "app", "index.js"), "module.exports = { dep: require('dep') };\n", "utf8");
    await writeFile(join(source, "node_modules", ".pnpm", "dep@1", "node_modules", "dep", "index.js"), "module.exports = {};\n", "utf8");
    await symlink(".pnpm/app@1/node_modules/app", join(source, "node_modules", "app"));
    await symlink("../../dep@1/node_modules/dep", join(source, "node_modules", ".pnpm", "app@1", "node_modules", "dep"));
    return source;
  }

  it("digests relative in-tree symlinks deterministically (pnpm layout identity)", async () => {
    const root = await directory();
    const source = await pnpmSource(root);
    const first = await computeArtifactId(source);
    const second = await computeArtifactId(source);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    // A layout-only change (the link target string participates) changes the identity.
    const other = await pnpmSource(root, "// v1\n");
    const { unlink } = await import("node:fs/promises");
    await unlink(join(other, "node_modules", ".pnpm", "app@1", "node_modules", "dep"));
    await symlink("../../dep@2/node_modules/dep", join(other, "node_modules", ".pnpm", "app@1", "node_modules", "dep"));
    expect(await computeArtifactId(other)).not.toBe(first);
  });

  it("refuses absolute or escaping symlinks (self-contained deployments)", async () => {
    const root = await directory();
    const source = await pnpmSource(root);
    await symlink("/etc/passwd", join(source, "node_modules", "absolute"));
    await expect(computeArtifactId(source)).rejects.toThrow(/unsafe symlink/);

    const escaping = await pnpmSource(root);
    await symlink("../../../../etc/passwd", join(escaping, "node_modules", "escape"));
    await expect(computeArtifactId(escaping)).rejects.toThrow(/unsafe symlink/);
  });

  it("stages a symlinked candidate preserving the pnpm layout in the immutable store", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await pnpmSource(root);
    const installed = await installer.installCandidate({ version: "1.0.0", sourceDirectory: source });
    expect(installed.artifactId).toBe(await computeArtifactId(source));
    const deployed = join(installer.versionsDirectory, installed.artifactId);
    // The deployed tree keeps the symlink layout (dereferencing it would break
    // transitive resolution).
    expect((await import("node:fs/promises").then((m) => m.lstat(join(deployed, "node_modules", "app")))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(deployed, "node_modules", "app"))).toBe(".pnpm/app@1/node_modules/app");
    expect(await readlink(join(deployed, "node_modules", ".pnpm", "app@1", "node_modules", "dep"))).toBe("../../dep@1/node_modules/dep");
    // Real Node resolution walks the preserved virtual store through the store copy.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync(process.execPath, ["-e", "process.stdout.write(require(process.argv[1]).dep ? 'ok' : 'missing')", join(deployed, "node_modules", "app", "index.js")]);
    expect(result.stdout).toBe("ok");
  });
});

describe("legacy semver/current/previous migration (#92)", () => {
  it("migrates a legacy layout without deleting the last known-good serving runtime", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const { versions: legacyVersions } = await legacyLayout(stateRoot, [
      { version: "0.9.0", bytes: "// rly 0.9.0\n" },
      { version: "1.0.0", bytes: "// rly 1.0.0\n" },
    ]);
    const artifactId1 = await computeArtifactId(join(legacyVersions, "1.0.0"));
    const artifactId0 = await computeArtifactId(join(legacyVersions, "0.9.0"));
    await link(join(stateRoot, "runtime"), "current", "versions/1.0.0");
    await link(join(stateRoot, "runtime"), "previous", "versions/0.9.0");

    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    // Any installer operation triggers migration; staging must not disturb it.
    const source = await candidateDirectory(root, "2.1.0", "// rly 2.1.0\n");
    const installed = await installer.installCandidate({ version: "2.1.0", sourceDirectory: source });

    // The legacy serving deployments were renamed (bytes preserved), never deleted.
    expect(await readlink(installer.activePath)).toBe(`../versions/${artifactId1}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${artifactId0}`);
    await expect(stat(join(legacyVersions, "1.0.0"))).rejects.toThrow();
    await expect(stat(join(legacyVersions, "0.9.0"))).rejects.toThrow();
    // Legacy `current`/`previous` symlinks are gone after the durable commit.
    await expect(stat(join(stateRoot, "runtime", "current"))).rejects.toThrow();
    await expect(stat(join(stateRoot, "runtime", "previous"))).rejects.toThrow();
    // The immutable deployments are validated and private.
    for (const artifactId of [artifactId1, artifactId0, installed.artifactId]) {
      expect(await stat(join(installer.versionsDirectory, artifactId))).toMatchObject({ mode: 0o40700 });
    }
    // A later install only stages: active/previous stay on the migrated refs.
    expect(await readlink(installer.stagedPath)).toBe(`../versions/${installed.artifactId}`);
    expect(await readlink(installer.activePath)).toBe(`../versions/${artifactId1}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${artifactId0}`);
  });

  it("recovers a crash between dir rename and ref creation from the durable migrating marker", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const { versions: legacyVersions } = await legacyLayout(stateRoot, [
      { version: "0.9.0", bytes: "// rly 0.9.0\n" },
      { version: "1.0.0", bytes: "// rly 1.0.0\n" },
    ]);
    const artifactId1 = await computeArtifactId(join(legacyVersions, "1.0.0"));
    const artifactId0 = await computeArtifactId(join(legacyVersions, "0.9.0"));
    // Crash window: 1.0.0 already renamed to its artifact id, marker written
    // as `migrating`, refs not yet created, legacy symlinks still present
    // (now dangling).
    await renameLegacyDir(legacyVersions, "1.0.0", artifactId1);
    await writeMigrationMarker(stateRoot, [
      { legacyName: "1.0.0", artifactId: artifactId1 },
      { legacyName: "0.9.0", artifactId: artifactId0 },
    ]);
    await link(join(stateRoot, "runtime"), "current", "versions/1.0.0");
    await link(join(stateRoot, "runtime"), "previous", "versions/0.9.0");

    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "2.1.0", "// rly 2.1.0\n");
    await installer.installCandidate({ version: "2.1.0", sourceDirectory: source });

    expect(await readlink(installer.activePath)).toBe(`../versions/${artifactId1}`);
    expect(await readlink(installer.previousPath)).toBe(`../versions/${artifactId0}`);
    await expect(stat(join(legacyVersions, "0.9.0"))).rejects.toThrow();
    await expect(stat(join(stateRoot, "runtime", "current"))).rejects.toThrow();
  });

  it("recovers a crash after ref creation but before the committed marker", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "2.0.0", "// rly 2.0.0\n");
    const installed = await installer.installCandidate({ version: "2.0.0", sourceDirectory: source });
    // Simulate: legacy `current` reintroduced + committed marker lost (crash
    // between ref write and marker commit).
    await rm(join(stateRoot, "runtime", "legacy-migration.json"), { force: true });
    await link(join(stateRoot, "runtime"), "current", `versions/${installed.artifactId}`);

    const recreated = new LocalCandidateInstaller({ directory: stateRoot });
    const source2 = await candidateDirectory(root, "2.1.0", "// rly 2.1.0\n");
    await recreated.installCandidate({ version: "2.1.0", sourceDirectory: source2 });

    // The existing valid active ref is adopted; legacy pointer cleaned.
    expect(await readlink(recreated.activePath)).toBe(`../versions/${installed.artifactId}`);
    await expect(stat(join(stateRoot, "runtime", "current"))).rejects.toThrow();
    expect((await readFile(join(stateRoot, "runtime", "legacy-migration.json"), "utf8")).includes("\"committed\"")).toBe(true);
  });

  it("fails closed on malformed legacy state with an actionable recovery path", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    await legacyLayout(stateRoot, [{ version: "1.0.0", bytes: "// rly 1.0.0\n" }]);
    // Dangling legacy serving reference (target deployment missing).
    await link(join(stateRoot, "runtime"), "current", "versions/9.9.9");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "2.0.0", "// rly 2.0.0\n");
    await expect(installer.installCandidate({ version: "2.0.0", sourceDirectory: source }))
      .rejects.toThrow(/unknown or missing deployment/);
    // The legacy bytes were never deleted by the failed migration.
    expect((await readdir(join(stateRoot, "runtime", "versions"))).sort()).toEqual(["1.0.0"]);
  });

  it("fails closed when a legacy current reference is not a symlink", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    await legacyLayout(stateRoot, [{ version: "1.0.0", bytes: "// rly 1.0.0\n" }]);
    await writeFile(join(stateRoot, "runtime", "current"), "not-a-symlink\n", "utf8");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "2.0.0", "// rly 2.0.0\n");
    await expect(installer.installCandidate({ version: "2.0.0", sourceDirectory: source }))
      .rejects.toThrow(DeploymentStoreError);
  });
});

describe("deployment metadata privacy and ownership (#92)", () => {
  it("writes identifier-only metadata with private permissions and no secret material", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "2.0.0", "// rly 2.0.0\n");
    const installed = await installer.installCandidate({ version: "2.0.0", sourceDirectory: source });

    const metadataPath = join(installer.versionsDirectory, installed.artifactId, DEPLOYMENT_METADATA_FILE_NAME);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(metadata).sort()).toEqual(
      ["artifactId", "installedAt", "migrationForwardOnly", "product", "schemaVersion", "stateVersion", "version"].sort(),
    );
    expect(metadata.artifactId).toBe(installed.artifactId);
    expect(metadata.version).toBe("2.0.0");
    const serialized = await readFile(metadataPath, "utf8");
    for (const forbidden of ["Bearer", "token", "secret", "password", "apiKey", "authorization", "email"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(installer.versionsDirectory, installed.artifactId))).mode & 0o777).toBe(0o700);
    expect((await stat(installer.refsDirectory)).mode & 0o777).toBe(0o700);
  });
});

async function renameLegacyDir(versions: string, from: string, to: string): Promise<void> {
  const { rename } = await import("node:fs/promises");
  await rename(join(versions, from), join(versions, to));
}

async function writeMigrationMarker(stateRoot: string, mappings: ReadonlyArray<{ legacyName: string; artifactId: string }>): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const runtime = join(stateRoot, "runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await writeFile(join(runtime, "legacy-migration.json"), `${JSON.stringify({
    schemaVersion: 1,
    state: "migrating",
    migratedAt: "2026-08-13T00:00:00.000Z",
    mappings: [...mappings],
  })}\n`, { mode: 0o600 });
}
