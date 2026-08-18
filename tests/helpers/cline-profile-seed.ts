import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ControlPlaneStore } from "../../src/control-plane/store.js";
import type { AccountRecord, PoolStrategy } from "../../src/control-plane/types.js";
import type { CredentialBroker } from "../../src/credentials/broker.js";
import { writeClineSource, writeCodexSource } from "../credentials/helpers.js";

export const CLINE_PRIMARY_MODEL = "claude-sonnet-4-5";
export const CLINE_PROFILE_ROLES = Object.freeze({
  primary: CLINE_PRIMARY_MODEL,
  fast: CLINE_PRIMARY_MODEL,
  reasoning: CLINE_PRIMARY_MODEL,
});

export const CLINE_FIXTURE_ACCESS_A = "cline-access-token-fixture-a-not-secret";
export const CLINE_FIXTURE_REFRESH_A = "cline-refresh-token-fixture-a-not-secret";
export const CLINE_FIXTURE_ACCESS_B = "cline-access-token-fixture-b-not-secret";
export const CLINE_FIXTURE_REFRESH_B = "cline-refresh-token-fixture-b-not-secret";

export { sseFixture } from "./codex-profile-seed.js";

export async function importClineAccount(
  store: ControlPlaneStore,
  broker: CredentialBroker,
  directory: string,
  providerId: string,
  spec: Readonly<{ pseudonym: string; access: string; refresh: string }>,
): Promise<AccountRecord> {
  const sourceDirectory = join(directory, spec.pseudonym);
  await mkdir(sourceDirectory, { recursive: true });
  const source = await writeClineSource(sourceDirectory, {
    access: spec.access,
    refresh: spec.refresh,
  });
  const metadata = await broker.importCline({
    sourcePath: source.path,
    pseudonym: spec.pseudonym,
    sourceFingerprint: source.sourceFingerprint,
  });
  const created = store.createAccount({
    pseudonym: spec.pseudonym,
    providerId,
    credentialHandle: metadata.handle,
  }, "cli");
  return store.bindCredential(created.id, created.version, {
    credentialHandle: metadata.handle,
    credentialGeneration: metadata.generation,
    state: "ready",
  }, "cli");
}

export async function seedClineClaudeProfile(
  store: ControlPlaneStore,
  broker: CredentialBroker,
  directory: string,
  input: Readonly<{
    endpoint: string;
    profileName?: string;
    strategy?: PoolStrategy;
    retryBudget?: number;
    affinity?: unknown;
    accounts?: readonly { pseudonym: string; access: string; refresh: string }[];
    modelRoles?: Readonly<Record<string, string>>;
  }>,
): Promise<Readonly<{ providerId: string; poolId: string; accounts: readonly AccountRecord[] }>> {
  const provider = store.createProvider({
    name: "cline",
    integrationMode: "oauth",
    endpointPolicy: input.endpoint,
  }, "cli");
  const specs = input.accounts ?? [{
    pseudonym: "acct-cline-a",
    access: CLINE_FIXTURE_ACCESS_A,
    refresh: CLINE_FIXTURE_REFRESH_A,
  }];
  const accounts: AccountRecord[] = [];
  for (const spec of specs) {
    accounts.push(await importClineAccount(store, broker, directory, provider.id, spec));
  }
  const pool = store.createPool({
    name: "clinepass-pool",
    providerId: provider.id,
    strategy: input.strategy ?? "fill-first",
    retryBudget: input.retryBudget ?? 1,
    ...(input.affinity === undefined ? {} : { affinity: input.affinity }),
    accountIds: accounts.map((account) => account.id),
  }, "cli");
  store.createProfile({
    name: input.profileName ?? "clinepass",
    harness: "claude",
    providerId: provider.id,
    poolId: pool.id,
    modelRoles: input.modelRoles ?? CLINE_PROFILE_ROLES,
  }, "cli");
  return { providerId: provider.id, poolId: pool.id, accounts };
}

export async function seedCodexCredentialFile(
  broker: CredentialBroker,
  directory: string,
  spec: Readonly<{ pseudonym: string; access: string; refresh: string }> = {
    pseudonym: "acct-codex-sentinel",
    access: "codex-access-sentinel-not-secret",
    refresh: "codex-refresh-sentinel-not-secret",
  },
): Promise<Readonly<{ handle: string; activePath: string }>> {
  const sourceDirectory = join(directory, spec.pseudonym);
  await mkdir(sourceDirectory, { recursive: true });
  const source = await writeCodexSource(sourceDirectory, {
    access: spec.access,
    refresh: spec.refresh,
  });
  const metadata = await broker.importCodex({
    sourcePath: source.path,
    pseudonym: spec.pseudonym,
    sourceFingerprint: source.sourceFingerprint,
  });
  return {
    handle: metadata.handle,
    activePath: join(broker.store.paths().credentials, `${metadata.handle}.json`),
  };
}
