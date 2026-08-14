import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderCapabilities } from "../../src/core/capabilities.js";
import type { ControlPlaneStore } from "../../src/control-plane/store.js";
import { ControlPlaneStore as Store } from "../../src/control-plane/store.js";
import type { AccountRecord, PoolRecord, PoolStrategy, ProviderRecord } from "../../src/control-plane/types.js";
import type { CredentialSnapshot } from "../../src/routing/eligibility/reasons.js";
import { AffinityStore } from "../../src/routing/pools/affinity.js";
import { RouteSelector } from "../../src/routing/pools/selector.js";

export const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelTools: false,
  images: false,
  reasoning: false,
  redactedReasoning: false,
  structuredOutput: false,
  tokenCounting: "unsupported",
};

export type AccountSpec = Readonly<{
  pseudonym: string;
  handle: string;
  state?: "ready" | "paused" | "unready" | "revoked";
  generation?: number;
  quotaClass?: string;
  terms?: string;
  cooldownUntil?: string;
}>;

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-gateway-routing-"));
}

export async function openStore(directory: string, now: Date): Promise<ControlPlaneStore> {
  return Store.open(directory, { clock: () => now });
}

export function createSelector(store: ControlPlaneStore, now: Date): RouteSelector {
  return new RouteSelector(store, new AffinityStore(store.directory), () => now);
}

export function readySnapshots(accounts: readonly AccountRecord[]): Map<string, CredentialSnapshot> {
  return new Map(accounts.map((account) => [account.credentialHandle, {
    present: true,
    generation: Math.max(account.credentialGeneration, 1),
  }]));
}

export function seedAccounts(
  store: ControlPlaneStore,
  provider: ProviderRecord,
  specs: readonly AccountSpec[],
): AccountRecord[] {
  return specs.map((spec) => {
    let account = store.createAccount({
      pseudonym: spec.pseudonym,
      providerId: provider.id,
      credentialHandle: spec.handle,
      ...(spec.quotaClass === undefined ? {} : { quotaClass: spec.quotaClass }),
    }, "cli");
    if (spec.terms !== undefined) account = store.acknowledgeTerms(account.id, account.version, spec.terms, "cli");
    const state = spec.state ?? "ready";
    if (state !== "unready" || (spec.generation ?? 0) > 0) {
      account = store.bindCredential(account.id, account.version, {
        credentialHandle: spec.handle,
        credentialGeneration: spec.generation ?? 1,
        state: state === "paused" ? "ready" : state,
      }, "cli");
    }
    if (state === "paused") {
      account = store.updateAccount(account.id, account.version, { state: "paused", pauseReason: "owner" }, "cli");
    }
    if (spec.cooldownUntil !== undefined) {
      account = store.recordRouteOutcome(account.id, {
        outcome: "transient",
        cooldownUntil: spec.cooldownUntil,
      });
    }
    return account;
  });
}

export function createReadyPool(
  store: ControlPlaneStore,
  input: Readonly<{
    strategy: PoolStrategy;
    specs: readonly AccountSpec[];
    retryBudget?: number;
    affinity?: unknown;
    requiredTermsRevision?: string;
  }>,
): Readonly<{ provider: ProviderRecord; accounts: AccountRecord[]; pool: PoolRecord }> {
  const provider = store.createProvider({
    name: `provider-${input.strategy}`,
    integrationMode: "oauth",
    ...(input.requiredTermsRevision === undefined ? {} : { requiredTermsRevision: input.requiredTermsRevision }),
  }, "cli");
  const accounts = seedAccounts(store, provider, input.specs);
  const pool = store.createPool({
    name: `pool-${input.strategy}`,
    providerId: provider.id,
    strategy: input.strategy,
    retryBudget: input.retryBudget ?? 1,
    ...(input.affinity === undefined ? {} : { affinity: input.affinity }),
    accountIds: accounts.map((account) => account.id),
  }, "cli");
  return { provider, accounts, pool };
}
