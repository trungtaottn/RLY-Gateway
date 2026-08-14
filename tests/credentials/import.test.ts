import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { CredentialBroker } from "../../src/credentials/broker.js";
import { CredentialService } from "../../src/credentials/service.js";
import { ImportIncompatibleError } from "../../src/credentials/errors.js";
import { CODEX_IMPORT_MAX_BYTES } from "../../src/providers/oauth/codex/source.js";
import { fakeOauth, FIXTURE_ACCESS, tempDirectory, writeCodexSource } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("codex credential import", () => {
  it("copies a supported source into the project store without mutating the source bytes", async () => {
    const directory = await tempDirectory("agent-gateway-cred-import-");
    directories.push(directory);
    const source = await writeCodexSource(directory);
    const before = await readFile(source.path);
    const store = await ControlPlaneStore.open(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const service = new CredentialService(store, broker);
    const provider = store.createProvider({ name: "codex", integrationMode: "oauth" }, "cli");
    const account = await service.importCodex({
      sourcePath: source.path,
      providerId: provider.id,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    }, "cli");
    expect(account.state).toBe("ready");
    expect(account.credentialGeneration).toBe(1);
    expect(await readFile(source.path)).toEqual(before);
    const scoped = await broker.resolve(account.credentialHandle);
    expect(scoped.accessToken.reveal()).toBe(FIXTURE_ACCESS);
    scoped.dispose();
    store.close();
    await broker.close();
  });

  it("rejects malformed, oversized, and changed sources and leaves no usable project record", async () => {
    const directory = await tempDirectory("agent-gateway-cred-import-fail-");
    directories.push(directory);
    const broker = await CredentialBroker.open(directory, { oauth: fakeOauth() });
    const bad = `${directory}/bad.json`;
    await writeFile(bad, "{", "utf8");
    await expect(broker.previewImport(bad)).rejects.toBeInstanceOf(ImportIncompatibleError);
    const huge = `${directory}/huge.json`;
    await writeFile(huge, "x".repeat(CODEX_IMPORT_MAX_BYTES + 1), "utf8");
    await expect(broker.previewImport(huge)).rejects.toBeInstanceOf(ImportIncompatibleError);
    const source = await writeCodexSource(directory);
    await writeFile(source.path, JSON.stringify({ tokens: { access_token: "changed-token-fixture", refresh_token: "changed-refresh-fixture" } }), "utf8");
    await expect(broker.importCodex({
      sourcePath: source.path,
      pseudonym: "acct-fixture-001",
      sourceFingerprint: source.sourceFingerprint,
    })).rejects.toBeInstanceOf(ImportIncompatibleError);
    await expect(broker.metadata("cred-missing")).resolves.toBeUndefined();
    const leftover = await (await import("node:fs/promises")).readdir(broker.store.paths().credentials);
    expect(leftover.filter((name) => name.startsWith("cred-") || name.endsWith(".tmp"))).toEqual([]);
    await broker.close();
  });
});
