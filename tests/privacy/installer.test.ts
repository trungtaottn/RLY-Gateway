import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSecretFree } from "../../src/control-plane/secret-free.js";
import { AcquisitionStateStore } from "../../src/installer/state.js";
import { acquisitionLogEntrySchema, type AcquisitionErrorCode, AcquisitionError } from "../../src/installer/types.js";
import { buildReleaseFixture } from "../helpers/installer-fixture.js";

const directories: string[] = [];

async function directory(prefix = "rly-installer-privacy-"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const FORBIDDEN = /Bearer\s+[A-Za-z0-9._~+/=-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|api[_-]?key\s*[:=]|password|accessToken|refreshToken|authorization\s*[:=]/i;

describe("installer/updater privacy (#129)", () => {
  it("VerifiedCandidate carries public build metadata only", async () => {
    const releaseDir = await directory("rly-fixture-");
    const fixture = await buildReleaseFixture({ releaseDir, version: "1.0.0-beta.5", channel: "beta" });
    const candidate = {
      product: "rly-gateway" as const,
      version: "1.0.0-beta.5",
      channel: "beta" as const,
      target: "linux-x64",
      filename: fixture.filename,
      sha256: fixture.sha256,
      artifactDigest: fixture.artifactDigest,
      buildId: fixture.buildId,
      commitRevision: fixture.sourceCommit,
      controlProtocolVersion: 1,
      dataProtocolVersion: 1,
      stateVersion: 2,
      qualificationStatus: "qualified" as const,
      sourceDirectory: "/private/staging/unpacked",
      metadataVersion: 1,
      verifiedAt: new Date().toISOString(),
    };
    assertSecretFree(candidate);
    const printed = JSON.stringify(candidate);
    expect(printed).not.toMatch(FORBIDDEN);
    expect(printed).not.toMatch(/token|secret|authorization|email|@/i);
  });

  it("acquisition-log records are schema-validated and secret-free", async () => {
    const controlPlane = await directory("rly-cp-");
    const store = new AcquisitionStateStore(controlPlane);
    const now = new Date().toISOString();
    const entry = {
      schemaVersion: 1 as const,
      at: now,
      kind: "channel-switch" as const,
      channel: "stable" as const,
      previousChannel: "beta" as const,
      version: "1.0.0",
      target: "linux-x64",
      sha256: "a".repeat(64),
      artifactDigest: "b".repeat(64),
      metadataVersion: 2,
      verifiedAt: now,
    };
    expect(acquisitionLogEntrySchema.safeParse(entry).success).toBe(true);
    await store.appendAcquisition(entry);
    const [persisted] = await store.readLog();
    assertSecretFree(persisted);
    expect(JSON.stringify(persisted)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(persisted)).not.toMatch(/token|secret|authorization|email|@/i);
  });

  it("acquisition errors are secret-free and carry a typed code", () => {
    const codes: readonly AcquisitionErrorCode[] = [
      "network", "channel-metadata-invalid", "channel-signature-invalid", "channel-rollback-detected",
      "channel-stale", "channel-frozen", "channel-unknown-version", "manifest-invalid",
      "manifest-signature-invalid", "manifest-identity-mismatch", "release-unknown", "target-unsupported",
      "target-not-qualified", "artifact-download-failed", "artifact-sha256-mismatch", "artifact-size-mismatch",
      "artifact-signature-missing", "artifact-signature-invalid", "artifact-tree-invalid",
      "artifact-digest-mismatch", "candidate-invalid", "unsupported-platform",
    ];
    for (const code of codes) {
      const error = new AcquisitionError(code, `${code} with an actionable message`);
      expect(error.code).toBe(code);
      expect(error.message).not.toMatch(FORBIDDEN);
      expect(error.message).not.toMatch(/token|secret|authorization|email|@/i);
    }
  });
});
