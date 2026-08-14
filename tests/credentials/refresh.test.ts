import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { OAuthFlowError, StaleGenerationError } from "../../src/credentials/errors.js";
import { fingerprintRefreshToken } from "../../src/providers/oauth/codex/protocol.js";
import {
  fakeOauth,
  fixtureTokens,
  FIXTURE_ACCESS_NEXT,
  FIXTURE_REFRESH,
  FIXTURE_REFRESH_NEXT,
  tempDirectory,
  writeCodexSource,
} from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("credential refresh", () => {
  it("single-flights concurrent refresh and commits one next generation", async () => {
    const directory = await tempDirectory("rly-gateway-refresh-");
    directories.push(directory);
    let release: ((value: ReturnType<typeof fixtureTokens>) => void) | undefined;
    const oauth = fakeOauth({
      refresh: () => new Promise((resolve) => {
        release = resolve;
      }),
    });
    const broker = await CredentialBroker.open(directory, { oauth });
    const source = await writeCodexSource(directory);
    const imported = await broker.importCodex({
      sourcePath: source.path,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    });
    const first = broker.refresh(imported.handle);
    const second = broker.refresh(imported.handle);
    await vi.waitFor(() => {
      expect(oauth.refreshCalls).toBe(1);
    });
    release?.(fixtureTokens({ accessToken: FIXTURE_ACCESS_NEXT, refreshToken: FIXTURE_REFRESH_NEXT }));
    const [left, right] = await Promise.all([first, second]);
    expect(left.generation).toBe(2);
    expect(right.generation).toBe(2);
    expect(oauth.refreshCalls).toBe(1);
    expect(left.refreshFingerprint).toBe(fingerprintRefreshToken(FIXTURE_REFRESH_NEXT));
    await broker.close();
  });

  it("does not let a stale refresh overwrite a newer generation", async () => {
    const directory = await tempDirectory("rly-gateway-refresh-stale-");
    directories.push(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const source = await writeCodexSource(directory);
    const imported = await broker.importCodex({
      sourcePath: source.path,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    });
    const current = await broker.store.read(imported.handle);
    await broker.store.commit(imported.handle, 1, {
      ...current,
      generation: 2,
      refreshFingerprint: fingerprintRefreshToken(FIXTURE_REFRESH_NEXT),
      material: { ...current.material, refreshToken: FIXTURE_REFRESH_NEXT, accessToken: FIXTURE_ACCESS_NEXT },
    });
    await expect(broker.store.commit(imported.handle, 1, {
      ...current,
      generation: 2,
      refreshFingerprint: fingerprintRefreshToken("stale-refresh-fixture-not-secret"),
      material: { ...current.material, refreshToken: "stale-refresh-fixture-not-secret" },
    })).rejects.toBeInstanceOf(StaleGenerationError);
    expect((await broker.store.read(imported.handle)).material.refreshToken).toBe(FIXTURE_REFRESH_NEXT);
    expect((await broker.store.read(imported.handle)).material.refreshToken).not.toBe(FIXTURE_REFRESH);
    await broker.close();
  });

  it("keeps the last valid generation when refresh fails", async () => {
    const directory = await tempDirectory("rly-gateway-refresh-fail-");
    directories.push(directory);
    const oauth = fakeOauth({
      refresh: () => Promise.reject(new OAuthFlowError("invalid-grant", "oauth token request failed")),
    });
    const broker = await CredentialBroker.open(directory, { oauth });
    const source = await writeCodexSource(directory);
    const imported = await broker.importCodex({
      sourcePath: source.path,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    });
    await expect(broker.refresh(imported.handle)).rejects.toBeTruthy();
    expect((await broker.store.read(imported.handle)).generation).toBe(1);
    await broker.close();
  });

  it("refreshes before bind and refuses a different generation at invoke", async () => {
    const directory = await tempDirectory("rly-gateway-bind-generation-");
    directories.push(directory);
    const oauth = fakeOauth();
    const broker = await CredentialBroker.open(directory, { oauth, clock: () => new Date("2026-08-13T00:00:00.000Z") });
    const source = await writeCodexSource(directory);
    const imported = await broker.importCodex({
      sourcePath: source.path,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    });
    const current = await broker.store.read(imported.handle);
    await broker.store.commit(imported.handle, current.generation, {
      ...current,
      generation: current.generation + 1,
      expiresAt: "2026-08-13T00:00:30.000Z",
    });
    expect(oauth.refreshCalls).toBe(0);
    const prepared = await broker.prepare(imported.handle);
    expect(oauth.refreshCalls).toBe(1);
    expect(prepared.generation).toBe(current.generation + 2);
    const scoped = await broker.bind(imported.handle, prepared.generation);
    expect(scoped.generation).toBe(prepared.generation);
    expect(oauth.refreshCalls).toBe(1);
    await expect(broker.bind(imported.handle, prepared.generation - 1)).rejects.toBeInstanceOf(StaleGenerationError);
    scoped.dispose();
    await broker.close();
  });
});
