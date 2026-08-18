import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { CredentialService } from "../../src/credentials/service.js";
import { toAccountDto, toAuditDto } from "../../src/management/dtos.js";
import { fakeOauth, FIXTURE_ACCESS, writeCodexSource } from "../credentials/helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("credential privacy", () => {
  it("keeps management DTOs, audit, and sqlite free of credential material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cred-privacy-"));
    directories.push(directory);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const service = new CredentialService(store, broker);
    const provider = store.createProvider({ name: "codex", integrationMode: "oauth" }, "cli");
    const source = await writeCodexSource(directory);
    const account = await service.importCodex({
      sourcePath: source.path,
      providerId: provider.id,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    }, "cli");
    const dto = toAccountDto(account, await service.readiness(account));
    const audit = store.listAudit().map(toAuditDto);
    const encoded = JSON.stringify({ dto, audit, policy: store.currentPolicy() });
    expect(encoded).not.toContain(FIXTURE_ACCESS);
    expect(encoded).not.toMatch(/accessToken|refreshToken|authorization/i);
    store.close();
    await broker.close();
  });
});
