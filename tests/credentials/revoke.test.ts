import { readdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { CredentialService } from "../../src/credentials/service.js";
import { CredentialUnreadyError } from "../../src/credentials/errors.js";
import { fakeOauth, tempDirectory, writeCodexSource } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("credential revoke", () => {
  it("removes usable active, temporary, and backup project records after revoke", async () => {
    const directory = await tempDirectory("agent-gateway-revoke-");
    directories.push(directory);
    let revoked = false;
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth({ revoke: () => { revoked = true; return Promise.resolve(); } }) });
    const service = new CredentialService(store, broker);
    const provider = store.createProvider({ name: "codex", integrationMode: "oauth" }, "cli");
    const source = await writeCodexSource(directory);
    const account = await service.importCodex({
      sourcePath: source.path,
      providerId: provider.id,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    }, "cli");
    await service.select(account.id, account.version, "cli");
    const revokedAccount = await service.revoke(account.id, account.version, "cli");
    expect(revokedAccount.state).toBe("revoked");
    expect(revoked).toBe(true);
    await expect(broker.resolve(account.credentialHandle)).rejects.toBeInstanceOf(CredentialUnreadyError);
    const remaining = await readdir(broker.store.paths().credentials);
    expect(remaining.filter((name) => name.startsWith(account.credentialHandle))).toEqual([]);
    expect(await service.selectedAccountId()).toBeUndefined();
    expect(await service.readiness(revokedAccount)).toBe("revoked");
    store.close();
    await broker.close();
  });
});
