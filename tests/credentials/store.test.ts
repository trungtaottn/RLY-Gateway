import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileMode, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../../src/storage/private-files.js";
import { CredentialStore } from "../../src/credentials/store.js";
import { StaleGenerationError, CredentialUnreadyError } from "../../src/credentials/errors.js";
import { fingerprintRefreshToken } from "../../src/providers/oauth/codex/protocol.js";
import type { CredentialRecord } from "../../src/credentials/record.js";
import { FIXTURE_ACCESS, FIXTURE_REFRESH, FIXTURE_ACCESS_NEXT, FIXTURE_REFRESH_NEXT, tempDirectory } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(generation: number, refresh = FIXTURE_REFRESH): CredentialRecord {
  return {
    schemaVersion: 1,
    provider: "codex",
    handle: "cred-fixture-001",
    pseudonym: "acct-fixture-001",
    generation,
    expiresAt: "2026-09-01T00:00:00.000Z",
    refreshFingerprint: fingerprintRefreshToken(refresh),
    material: { accessToken: generation === 1 ? FIXTURE_ACCESS : FIXTURE_ACCESS_NEXT, refreshToken: refresh },
  };
}

describe("credential store", () => {
  it("writes restrictive files and recovers the last valid generation after a corrupt active file", async () => {
    const directory = await tempDirectory("rly-gateway-cred-store-");
    directories.push(directory);
    const store = await CredentialStore.open(directory);
    await store.commit("cred-fixture-001", 0, record(1));
    const details = await lstat(store.paths().credentials);
    expect(fileMode(details.mode)).toBe(PRIVATE_DIRECTORY_MODE);
    expect(fileMode((await lstat(join(store.paths().credentials, "cred-fixture-001.json"))).mode)).toBe(PRIVATE_FILE_MODE);
    await store.commit("cred-fixture-001", 1, record(2, FIXTURE_REFRESH_NEXT));
    const activePath = join(store.paths().credentials, "cred-fixture-001.json");
    const valid = await readFile(activePath, "utf8");
    await writeFile(join(store.paths().credentials, "cred-fixture-001.bak"), valid, "utf8");
    await chmod(join(store.paths().credentials, "cred-fixture-001.bak"), PRIVATE_FILE_MODE);
    await writeFile(activePath, "{not-json", "utf8");
    await chmod(activePath, PRIVATE_FILE_MODE);
    const recovered = await CredentialStore.open(directory);
    const current = await recovered.read("cred-fixture-001");
    expect(current.generation).toBe(2);
    expect(current.material.refreshToken).toBe(FIXTURE_REFRESH_NEXT);
  });

  it("rejects a stale generation commit and leaves the newer record in place", async () => {
    const directory = await tempDirectory("rly-gateway-cred-cas-");
    directories.push(directory);
    const store = await CredentialStore.open(directory);
    await store.commit("cred-fixture-001", 0, record(1));
    await store.commit("cred-fixture-001", 1, record(2, FIXTURE_REFRESH_NEXT));
    await expect(store.commit("cred-fixture-001", 1, {
      ...record(2, "refresh-token-stale-not-secret"),
      refreshFingerprint: fingerprintRefreshToken("refresh-token-stale-not-secret"),
    })).rejects.toBeInstanceOf(StaleGenerationError);
    expect((await store.read("cred-fixture-001")).material.refreshToken).toBe(FIXTURE_REFRESH_NEXT);
  });

  it("marks a handle unready when active and backup records are both unusable", async () => {
    const directory = await tempDirectory("rly-gateway-cred-unready-");
    directories.push(directory);
    const store = await CredentialStore.open(directory);
    await store.commit("cred-fixture-001", 0, record(1));
    await writeFile(join(store.paths().credentials, "cred-fixture-001.json"), "{", "utf8");
    await chmod(join(store.paths().credentials, "cred-fixture-001.json"), PRIVATE_FILE_MODE);
    const recovered = await CredentialStore.open(directory);
    await expect(recovered.read("cred-fixture-001")).rejects.toBeInstanceOf(CredentialUnreadyError);
  });

  it("deletes leftover temporary files during recovery", async () => {
    const directory = await tempDirectory("rly-gateway-cred-tmp-");
    directories.push(directory);
    const store = await CredentialStore.open(directory);
    await store.commit("cred-fixture-001", 0, record(1));
    const tmp = join(store.paths().credentials, ".cred-fixture-001.leftover.tmp");
    await writeFile(tmp, "partial", "utf8");
    await chmod(tmp, PRIVATE_FILE_MODE);
    const recovered = await CredentialStore.open(directory);
    const names = await (await import("node:fs/promises")).readdir(recovered.paths().credentials);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect((await recovered.read("cred-fixture-001")).generation).toBe(1);
  });

  it("reclaims a crashed-process lock and refuses to steal a live lock", async () => {
    const directory = await tempDirectory("rly-gateway-cred-lock-");
    directories.push(directory);
    const store = await CredentialStore.open(directory);
    await store.commit("cred-fixture-001", 0, record(1));
    const { writePrivateTextAtomically } = await import("../../src/storage/private-files.js");
    const lockPath = join(store.paths().credentialLocks, "cred-fixture-001.lock");
    await writePrivateTextAtomically(lockPath, "cred-fixture-001");
    const recovered = await CredentialStore.open(directory);
    const next = await recovered.commit("cred-fixture-001", 1, record(2, FIXTURE_REFRESH_NEXT));
    expect(next.generation).toBe(2);

    const { readProcessIdentity } = await import("../../src/runtime/process-identity.js");
    const owner = await readProcessIdentity(process.pid);
    if (!owner) throw new Error("expected process identity");
    await writePrivateTextAtomically(lockPath, `${JSON.stringify({
      lockId: "00000000-0000-4000-8000-000000000099",
      createdAt: "2026-08-13T00:00:00.000Z",
      owner,
      resource: "cred-fixture-001",
    })}\n`);
    await expect(recovered.commit("cred-fixture-001", 2, {
      ...record(3, "refresh-token-live-lock-not-secret"),
      refreshFingerprint: fingerprintRefreshToken("refresh-token-live-lock-not-secret"),
    })).rejects.toMatchObject({ statusCode: 409, code: "locked" });
    expect((await recovered.read("cred-fixture-001")).generation).toBe(2);
  });
});
