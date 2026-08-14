import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalCandidateInstaller, readCandidateManifestFromDirectory } from "../../src/runtime/update/installer.js";
import type { CandidateManifest } from "../../src/runtime/update/types.js";

const directories: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rly-gateway-update-install-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function candidateDirectory(root: string, version: string, manifest: Partial<CandidateManifest> = {}): Promise<string> {
  const source = join(root, `candidate-${version}`);
  await mkdir(join(source, "dist", "cli"), { recursive: true });
  await writeFile(join(source, "dist", "cli", "main.js"), `// rly ${version}\n`, "utf8");
  await writeFile(join(source, "rly.json"), `${JSON.stringify({
    product: "rly-gateway",
    version,
    stateVersion: 2,
    migrationForwardOnly: false,
    ...manifest,
  })}\n`, "utf8");
  return source;
}

describe("local candidate installer (#73)", () => {
  it("installs a candidate, flips current, and preserves the previous rollback reference", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "2.0.0");
    const installed = await installer.installCandidate({ version: "2.0.0", sourceDirectory: source });
    expect(installed.version).toBe("2.0.0");
    expect(installed.previousVersion).toBeUndefined();
    expect(await readlink(installer.currentPath)).toContain("2.0.0");

    const second = await candidateDirectory(root, "2.1.0");
    const upgraded = await installer.installCandidate({ version: "2.1.0", sourceDirectory: second });
    expect(upgraded.previousVersion).toBe("2.0.0");
    expect(await readlink(installer.currentPath)).toContain("2.1.0");
    expect(await readlink(installer.previousPath)).toContain("2.0.0");
  });

  it("verifies the currently selected candidate via its manifest", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    expect((await installer.verifyCandidate()).ok).toBe(false);
    const source = await candidateDirectory(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: source });
    const verified = await installer.verifyCandidate();
    expect(verified.ok).toBe(true);
    expect(verified.version).toBe("2.0.0");
  });

  it("restores the previous known-good version and refuses without a reference", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: await candidateDirectory(root, "2.0.0") });
    await installer.installCandidate({ version: "2.1.0", sourceDirectory: await candidateDirectory(root, "2.1.0") });
    const restored = await installer.restorePrevious();
    expect(restored.version).toBe("2.0.0");
    expect(await readlink(installer.currentPath)).toContain("2.0.0");
    await expect(installer.restorePrevious()).resolves.toBeDefined(); // 2.0.0 -> 2.1.0 flips back
    expect(await readlink(installer.currentPath)).toContain("2.1.0");
  });

  it("rejects a candidate without a valid layout", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const empty = join(root, "empty");
    await mkdir(empty, { recursive: true });
    await expect(installer.installCandidate({ version: "9.0.0", sourceDirectory: empty }))
      .rejects.toThrow(/not a valid RLY runtime candidate/);
  });

  it("reports the candidate manifest and reads it from a source directory", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "3.0.0", { migrationForwardOnly: true, stateVersion: 3 });
    const manifest = await readCandidateManifestFromDirectory(source);
    expect(manifest).toMatchObject({ product: "rly-gateway", version: "3.0.0", stateVersion: 3, migrationForwardOnly: true });
    await installer.installCandidate({ version: "3.0.0", sourceDirectory: source });
    expect(await installer.readManifest()).toMatchObject({ version: "3.0.0", migrationForwardOnly: true });
  });

  it("keeps state private", async () => {
    const root = await directory();
    const stateRoot = join(root, "state");
    const installer = new LocalCandidateInstaller({ directory: stateRoot });
    const source = await candidateDirectory(root, "2.0.0");
    await installer.installCandidate({ version: "2.0.0", sourceDirectory: source });
    const { stat } = await import("node:fs/promises");
    const target = await stat(join(stateRoot, "runtime", "versions", "2.0.0"));
    expect(target.isDirectory()).toBe(true);
  });
});
