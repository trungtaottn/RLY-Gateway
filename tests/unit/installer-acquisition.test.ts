import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireVerifiedCandidate, installVerifiedCandidate, verifyLocalAcquisition, hostTarget } from "../../src/installer/acquire.js";
import { AcquisitionError } from "../../src/installer/types.js";
import { AcquisitionStateStore } from "../../src/installer/state.js";
import { runtimePaths } from "../../src/storage/paths.js";
import { readPrivateSymlinkTarget } from "../../src/storage/private-files.js";
import { buildReleaseFixture, fixtureFetch } from "../helpers/installer-fixture.js";

const directories: string[] = [];

async function directory(prefix = "rly-installer-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const ORIGIN = "https://github.com/trungtaottn/RLY-Gateway";

describe("verified remote acquisition (#129)", () => {
  it("acquires the exact artifact through the signed metadata chain", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta" });
    const candidate = await acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    });
    expect(candidate.product).toBe("rly-gateway");
    expect(candidate.version).toBe("1.0.0-beta.5");
    expect(candidate.channel).toBe("beta");
    expect(candidate.target).toBe("linux-x64");
    expect(candidate.sha256).toBe(fixture.sha256);
    expect(candidate.artifactDigest).toBe(fixture.artifactDigest);
    expect(candidate.buildId).toBe(fixture.buildId);
    expect(candidate.commitRevision).toBe(fixture.sourceCommit);
    expect(candidate.metadataVersion).toBe(fixture.channelMetadataVersion);
    expect(candidate.qualificationStatus).toBe("qualified");
    // The unpacked tree is verified: dist/cli/main.js must be present.
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(candidate.sourceDirectory, "dist", "cli", "main.js"), "utf8")).resolves.toContain("fixture");
  });

  it("stages a verified candidate without touching refs/active (INSTALL != ACTIVATE)", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const controlPlane = await directory("rly-cp-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta" });
    const candidate = await acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    });
    await installVerifiedCandidate({ candidate, controlPlaneDirectory: controlPlane });
    const paths = runtimePaths(controlPlane);
    // staged points at the #92 immutable deployment of the verified tree;
    // active/previous must NOT exist (INSTALL != ACTIVATE).
    const { computeArtifactId } = await import("../../src/runtime/update/installer.js");
    const expectedArtifactId = await computeArtifactId(candidate.sourceDirectory);
    const staged = await readPrivateSymlinkTarget(paths.staged);
    expect(staged).toBe(`../versions/${expectedArtifactId}`);
    expect(await readPrivateSymlinkTarget(paths.active)).toBeUndefined();
    expect(await readPrivateSymlinkTarget(paths.previous)).toBeUndefined();
  });

  it("rejects an unsupported target before any install mutation", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const controlPlane = await directory("rly-cp-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta" });
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "windows-x64" as never,
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "target-unsupported" });
    expect(await readPrivateSymlinkTarget(runtimePaths(controlPlane).active)).toBeUndefined();
    expect(await readPrivateSymlinkTarget(runtimePaths(controlPlane).staged)).toBeUndefined();
  });

  it("rejects stale channel metadata", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({
      releaseDir,
      version: "1.0.0-beta.5",
      channel: "beta",
      publishedAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: "2026-08-20T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "channel-stale" });
  });

  it("detects a channel-metadata rollback (version below the observed highest)", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta", channelVersion: 2 });
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      highestObservedVersion: 10,
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "channel-rollback-detected" });
  });

  it("refuses a frozen channel", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta", freeze: true });
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "channel-frozen" });
  });

  it("rejects a digest mismatch before any install mutation", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const controlPlane = await directory("rly-cp-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta" });
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture, { tamperTarball: true }),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "artifact-sha256-mismatch" });
    expect(await readPrivateSymlinkTarget(runtimePaths(controlPlane).active)).toBeUndefined();
    expect(await readPrivateSymlinkTarget(runtimePaths(controlPlane).staged)).toBeUndefined();
  });

  it("fails closed when the artifact signature is missing", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta" });
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture, { omitSignature: true }),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "artifact-signature-missing" });
  });

  it("rejects an artifact signature that does not verify", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta" });
    const { readFile, writeFile } = await import("node:fs/promises");
    const sigPath = join(releaseDir, `${fixture.filename}.sig`);
    const sig = JSON.parse(await readFile(sigPath, "utf8")) as { signature: string };
    await writeFile(sigPath, `${JSON.stringify({ ...sig, signature: "A".repeat(88) })}\n`, "utf8");
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "artifact-signature-invalid" });
  });

  it("rejects a channel signature that does not verify", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta" });
    const { readFile, writeFile } = await import("node:fs/promises");
    const sigPath = join(releaseDir, "rly-channel-beta.json.sig");
    const sig = JSON.parse(await readFile(sigPath, "utf8")) as { signature: string };
    await writeFile(sigPath, `${JSON.stringify({ ...sig, signature: "B".repeat(88) })}\n`, "utf8");
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "channel-signature-invalid" });
  });

  it("blocks an experimental target on the stable channel", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({
      releaseDir,
      version: "1.0.0",
      channel: "stable",
      targetStatus: "experimental",
      qualificationStatus: "qualified",
    });
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "stable",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "target-unsupported" });
  });

  it("blocks a not-qualified target on the stable channel", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({
      releaseDir,
      version: "1.0.0",
      channel: "stable",
      qualificationStatus: "not-qualified",
    });
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "stable",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "target-not-qualified" });
  });

  it("permits an experimental-gaps target on the beta channel and reports it", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({
      releaseDir,
      version: "1.0.0-beta.5",
      channel: "beta",
      targetStatus: "experimental",
      qualificationStatus: "experimental-gaps",
    });
    const candidate = await acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    });
    expect(candidate.qualificationStatus).toBe("experimental-gaps");
  });

  it("rejects an unknown release identity (no channel snapshot)", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta", unknownSnapshot: true });
    await expect(acquireVerifiedCandidate({
      origin: ORIGIN,
      channel: "beta",
      target: "linux-x64",
      stagingDirectory: staging,
      fetchImpl: fixtureFetch(fixture),
      publicKeyPem: fixture.publicKeyPem,
      version: "1.0.0-beta.5",
      now: fixture.publishedAt,
    })).rejects.toMatchObject({ code: "channel-unknown-version" });
  });

  it("verifyLocalAcquisition re-verifies the bootstrap-installer handoff from local files", async () => {
    const releaseDir = await directory("rly-fixture-");
    const staging = await directory("rly-staging-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta" });
    const candidate = await verifyLocalAcquisition({
      metadataDirectory: releaseDir,
      tarballPath: fixture.tarballPath,
      channel: "beta",
      target: "linux-x64",
      publicKeyPem: fixture.publicKeyPem,
      now: fixture.publishedAt,
    });
    expect(candidate.version).toBe("1.0.0-beta.5");
    expect(candidate.sha256).toBe(fixture.sha256);
    expect(candidate.artifactDigest).toBe(fixture.artifactDigest);
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(join(candidate.sourceDirectory, "dist", "cli", "main.js"), "utf8")).resolves.toContain("fixture");
    expect(staging).not.toBe(candidate.sourceDirectory);
  });

  it("records observed channel versions and rejects later rollback via the durable store", async () => {
    const controlPlane = await directory("rly-cp-");
    const store = new AcquisitionStateStore(controlPlane);
    expect(await store.highestObservedVersion("beta")).toBe(0);
    await store.recordObserved("beta", 7);
    expect(await store.highestObservedVersion("beta")).toBe(7);
    await store.recordObserved("beta", 5); // older never lowers
    expect(await store.highestObservedVersion("beta")).toBe(7);
    const log = await store.readLog();
    expect(log).toEqual([]);
  });
});

describe("installer platform matrix", () => {
  it("resolves the host target or null for unsupported platforms", () => {
    expect(hostTarget("linux", "x64")).toBe("linux-x64");
    expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTarget("win32", "x64")).toBeNull();
    expect(hostTarget("linux", "ia32")).toBeNull();
  });
});

describe("installer error taxonomy", () => {
  it("AcquisitionError carries a typed code and secret-free message", () => {
    const error = new AcquisitionError("target-unsupported", "no artifact for target windows-x64");
    expect(error.code).toBe("target-unsupported");
    expect(error.message).not.toMatch(/Bearer|token|api[_-]?key|authorization|@/i);
  });
});
