import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ControlPlaneStore } from "../../src/control-plane/store.js";
import type { AccountRecord, PoolStrategy } from "../../src/control-plane/types.js";
import type { CredentialBroker } from "../../src/credentials/broker.js";
import { writeCodexSource } from "../credentials/helpers.js";

export const CODEX_PRIMARY_MODEL = "gpt-5.4";
export const CODEX_PROFILE_ROLES = Object.freeze({
  primary: CODEX_PRIMARY_MODEL,
  fast: CODEX_PRIMARY_MODEL,
  reasoning: CODEX_PRIMARY_MODEL,
});

export const FIXTURE_ACCESS_A = "access-token-fixture-a-not-secret";
export const FIXTURE_REFRESH_A = "refresh-token-fixture-a-not-secret";
export const FIXTURE_ACCESS_B = "access-token-fixture-b-not-secret";
export const FIXTURE_REFRESH_B = "refresh-token-fixture-b-not-secret";

export function sseFixture(id: string, text: string): string {
  return [
    `data: {"id":"${id}","choices":[{"delta":{"content":"${text}"}}]}\n\n`,
    `data: {"id":"${id}","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

export async function importCodexAccount(
  store: ControlPlaneStore,
  broker: CredentialBroker,
  directory: string,
  providerId: string,
  spec: Readonly<{ pseudonym: string; access: string; refresh: string }>,
): Promise<AccountRecord> {
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

export async function seedCodexClaudeProfile(
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
    name: "codex",
    integrationMode: "oauth",
    endpointPolicy: input.endpoint,
  }, "cli");
  const specs = input.accounts ?? [{
    pseudonym: "acct-codex-a",
    access: FIXTURE_ACCESS_A,
    refresh: FIXTURE_REFRESH_A,
  }];
  const accounts: AccountRecord[] = [];
  for (const spec of specs) {
    accounts.push(await importCodexAccount(store, broker, directory, provider.id, spec));
  }
  const pool = store.createPool({
    name: "codex-pool",
    providerId: provider.id,
    strategy: input.strategy ?? "fill-first",
    retryBudget: input.retryBudget ?? 1,
    ...(input.affinity === undefined ? {} : { affinity: input.affinity }),
    accountIds: accounts.map((account) => account.id),
  }, "cli");
  store.createProfile({
    name: input.profileName ?? "codex",
    harness: "claude",
    providerId: provider.id,
    poolId: pool.id,
    modelRoles: input.modelRoles ?? CODEX_PROFILE_ROLES,
  }, "cli");
  return { providerId: provider.id, poolId: pool.id, accounts };
}
