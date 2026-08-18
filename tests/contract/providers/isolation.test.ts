import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialBroker } from "../../../src/credentials/broker.js";
import { ImportIncompatibleError, OAuthFlowError } from "../../../src/credentials/errors.js";
import { createProviderAdapter } from "../../../src/providers/dispatch.js";
import { ProviderAdapterError } from "../../../src/providers/provider-adapter.js";
import { fakeOauth, fingerprint, tempDirectory, writeCodexSource } from "../../credentials/helpers.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("expected port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe("provider credential isolation", () => {
  it("does not let a failed Gemini refresh mutate a Codex credential", async () => {
    const directory = await tempDirectory("rly-gateway-iso-");
    directories.push(directory);
    const source = await writeCodexSource(directory);
    const gemini = fakeOauth({
      refresh: () => Promise.reject(new Error("gemini refresh failed")),
    });
    const port = await availablePort();
    const broker = await CredentialBroker.open(directory, {
      oauth: fakeOauth(),
      oauthClients: { gemini },
      callbackPort: port,
    });
    const codex = await broker.importCodex({
      sourcePath: source.path,
      pseudonym: "acct-codex",
      sourceFingerprint: source.sourceFingerprint,
    });
    const started = await broker.startLogin({
      providerId: "00000000-0000-4000-8000-000000000099",
      pseudonym: "acct-gemini",
      provider: "gemini",
    });
    await fetch(`${started.redirectUri}?code=fixture-code&state=${started.state}`);
    const geminiRecord = await broker.waitForLogin();
    expect(geminiRecord.provider).toBe("gemini");
    await expect(broker.refresh(geminiRecord.handle)).rejects.toThrow("gemini refresh failed");
    const still = await broker.metadata(codex.handle);
    expect(still?.generation).toBe(1);
    expect(still?.provider).toBe("codex");
    await broker.close();
  });

  it("stores Cline material as cline and refuses Codex refresh", async () => {
    const directory = await tempDirectory("rly-gateway-cline-iso-");
    directories.push(directory);
    const sourcePath = join(directory, "cline-auth.json");
    const raw = JSON.stringify({ tokens: { access_token: "cline-access-fixture", refresh_token: "cline-refresh-fixture" } });
    await writeFile(sourcePath, raw, "utf8");
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const preview = await broker.previewImport(sourcePath, "cline");
    expect(preview.provider).toBe("cline");
    const imported = await broker.importCline({
      sourcePath,
      pseudonym: "acct-cline",
      sourceFingerprint: fingerprint(raw),
    });
    expect(imported.provider).toBe("cline");
    await expect(broker.refresh(imported.handle)).rejects.toBeInstanceOf(OAuthFlowError);
    await expect(broker.startLogin({
      providerId: "00000000-0000-4000-8000-000000000099",
      pseudonym: "acct-cline-login",
      provider: "cline",
    })).rejects.toBeInstanceOf(OAuthFlowError);
    const after = await broker.startLogin({
      providerId: "00000000-0000-4000-8000-000000000099",
      pseudonym: "acct-codex-after-cline",
      provider: "codex",
    });
    expect(typeof after.state).toBe("string");
    expect(after.state.length).toBeGreaterThan(0);
    await broker.close();
  });

  it("does not mutate Codex credential files when Cline import or refresh fails", async () => {
    const directory = await tempDirectory("rly-gateway-cline-codex-iso-");
    directories.push(directory);
    const source = await writeCodexSource(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const codex = await broker.importCodex({
      sourcePath: source.path,
      pseudonym: "acct-codex",
      sourceFingerprint: source.sourceFingerprint,
    });
    const { readFile } = await import("node:fs/promises");
    const activePath = join(broker.store.paths().credentials, `${codex.handle}.json`);
    const before = await readFile(activePath);
    const clinePath = join(directory, "cline-auth.json");
    await writeFile(clinePath, JSON.stringify({}), "utf8");
    await expect(broker.importCline({
      sourcePath: clinePath,
      pseudonym: "acct-cline-bad",
      sourceFingerprint: fingerprint("{}"),
    })).rejects.toBeInstanceOf(ImportIncompatibleError);
    const validCline = join(directory, "cline-valid.json");
    const raw = JSON.stringify({ tokens: { access_token: "cline-access-fixture", refresh_token: "cline-refresh-fixture" } });
    await writeFile(validCline, raw, "utf8");
    const imported = await broker.importCline({
      sourcePath: validCline,
      pseudonym: "acct-cline",
      sourceFingerprint: fingerprint(raw),
    });
    await expect(broker.refresh(imported.handle)).rejects.toBeInstanceOf(OAuthFlowError);
    expect(await readFile(activePath)).toEqual(before);
    const still = await broker.metadata(codex.handle);
    expect(still?.generation).toBe(1);
    expect(still?.provider).toBe("codex");
    await broker.close();
  });

  it("fails closed instead of selecting OpenRouter when an OAuth adapter has no token", () => {
    expect(() => createProviderAdapter({
      provider: {
        id: "00000000-0000-4000-8000-000000000001",
        name: "gemini",
        integrationMode: "oauth",
        endpointPolicy: undefined,
        capabilityEvidence: undefined,
        requiredTermsRevision: undefined,
        provenanceRef: undefined,
        enabled: true,
        version: 1,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      request: fetch,
      environment: {},
    })).toThrow(ProviderAdapterError);
  });
});
