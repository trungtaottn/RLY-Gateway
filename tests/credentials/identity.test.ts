import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { ValidationError } from "../../src/control-plane/errors.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { CredentialService } from "../../src/credentials/service.js";
import { fakeOauth, tempDirectory, writeCodexSource } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("provider-scoped account identity", () => {
  it("attaches by provider and pseudonym and leaves the same pseudonym on another provider alone", async () => {
    const directory = await tempDirectory("rly-gateway-identity-scope-");
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const service = new CredentialService(store, broker);
    const codex = store.createProvider({ name: "codex", integrationMode: "oauth" }, "cli");
    const gemini = store.createProvider({ name: "gemini", integrationMode: "oauth" }, "cli");
    store.createAccount({
      pseudonym: "acct-shared",
      providerId: gemini.id,
      credentialHandle: "cred-gemini-existing",
    }, "cli");
    const source = await writeCodexSource(directory);
    const attached = await service.importCodex({
      sourcePath: source.path,
      providerId: codex.id,
      pseudonym: "acct-shared",
      sourceFingerprint: source.sourceFingerprint,
    }, "cli");
    expect(attached.providerId).toBe(codex.id);
    expect(attached.pseudonym).toBe("acct-shared");
    const geminiAccount = store.listAccounts().find((account) => account.providerId === gemini.id);
    expect(geminiAccount?.credentialHandle).toBe("cred-gemini-existing");
    expect(store.listAccounts().filter((account) => account.pseudonym === "acct-shared")).toHaveLength(2);
    store.close();
    await broker.close();
  });

  it("fails closed when the credential provider does not match the account provider", async () => {
    const directory = await tempDirectory("rly-gateway-identity-mismatch-");
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const service = new CredentialService(store, broker);
    const gemini = store.createProvider({ name: "gemini", integrationMode: "oauth" }, "cli");
    const source = await writeCodexSource(directory);
    await expect(service.importCodex({
      sourcePath: source.path,
      providerId: gemini.id,
      pseudonym: "acct-mismatch",
      sourceFingerprint: source.sourceFingerprint,
    }, "cli")).rejects.toBeInstanceOf(ValidationError);
    expect(store.listAccounts()).toHaveLength(0);
    expect(await broker.store.listHandles()).toHaveLength(0);
    store.close();
    await broker.close();
  });
});
