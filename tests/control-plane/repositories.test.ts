import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneStore } from "../../src/control-plane/store.js";
import { UniquenessError, ValidationError, VersionConflictError } from "../../src/control-plane/errors.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function openStore(): Promise<ControlPlaneStore> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-cp-"));
  directories.push(directory);
  return ControlPlaneStore.open(directory);
}

describe("control-plane repositories", () => {
  it("creates versioned providers, accounts, pools, and profiles and compiles a policy revision", async () => {
    const store = await openStore();
    try {
      const provider = store.createProvider({
        name: "codex",
        integrationMode: "oauth",
        requiredTermsRevision: "terms-1",
        provenanceRef: "docs/provenance.md",
      }, "cli");
      const account = store.createAccount({
        pseudonym: "acct-001",
        providerId: provider.id,
        credentialHandle: "cred-001",
      }, "cli");
      store.acknowledgeTerms(account.id, account.version, "terms-1", "cli");
      const pool = store.createPool({
        name: "primary-pool",
        providerId: provider.id,
        strategy: "round-robin",
        retryBudget: 1,
        accountIds: [account.id],
      }, "cli");
      store.createProfile({
        name: "work",
        harness: "claude",
        providerId: provider.id,
        poolId: pool.id,
        modelRoles: { primary: "codex-primary" },
      }, "cli");
      const policy = store.currentPolicy();
      expect(policy?.revision).toBeGreaterThanOrEqual(5);
      expect(policy?.snapshot.accounts[0]?.pseudonym).toBe("acct-001");
      expect(JSON.stringify(policy)).not.toMatch(/accessToken|refreshToken|email|authorization/i);
      expect(store.listAudit().length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("rejects stale versions, duplicate memberships, and cross-provider pool members", async () => {
    const store = await openStore();
    try {
      const provider = store.createProvider({ name: "one", integrationMode: "direct" }, "cli");
      const other = store.createProvider({ name: "two", integrationMode: "direct" }, "cli");
      const account = store.createAccount({
        pseudonym: "acct-001",
        providerId: provider.id,
        credentialHandle: "cred-001",
      }, "cli");
      const foreign = store.createAccount({
        pseudonym: "acct-002",
        providerId: other.id,
        credentialHandle: "cred-002",
      }, "cli");
      expect(() => store.updateProvider(provider.id, 99, { enabled: false }, "cli")).toThrow(VersionConflictError);
      expect(() => store.createPool({
        name: "bad",
        providerId: provider.id,
        strategy: "manual",
        accountIds: [account.id, account.id],
      }, "cli")).toThrow(UniquenessError);
      expect(() => store.createPool({
        name: "cross",
        providerId: provider.id,
        strategy: "manual",
        accountIds: [foreign.id],
      }, "cli")).toThrow(ValidationError);
      store.createPool({ name: "unique", providerId: provider.id, strategy: "manual" }, "cli");
      expect(() => store.createPool({ name: "unique", providerId: provider.id, strategy: "manual" }, "cli")).toThrow(UniquenessError);
      const shared = store.createAccount({
        pseudonym: "acct-001",
        providerId: other.id,
        credentialHandle: "cred-shared",
      }, "cli");
      expect(shared.pseudonym).toBe("acct-001");
      expect(shared.providerId).toBe(other.id);
      expect(() => store.createAccount({
        pseudonym: "acct-001",
        providerId: provider.id,
        credentialHandle: "cred-dup",
      }, "cli")).toThrow(UniquenessError);
      expect(() => store.createProvider({
        name: "secret-json",
        integrationMode: "direct",
        capabilityEvidence: { email: "hidden" },
      }, "cli")).toThrow(ValidationError);
      const paused = store.updateAccount(account.id, account.version, { state: "paused", pauseReason: "owner" }, "cli");
      expect(paused.state).toBe("paused");
      expect(store.listAudit().some((event) => event.result === "rejected")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("preserves uniqueness under concurrent versioned mutations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rly-gateway-race-"));
    directories.push(directory);
    const left = await ControlPlaneStore.open(directory);
    const right = await ControlPlaneStore.open(directory);
    try {
      const provider = left.createProvider({ name: "shared", integrationMode: "direct" }, "cli");
      const results = await Promise.allSettled([
        Promise.resolve().then(() => right.updateProvider(provider.id, 1, { enabled: false }, "cli")),
        Promise.resolve().then(() => left.updateProvider(provider.id, 1, { name: "renamed" }, "cli")),
      ]);
      const accepted = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const current = left.listProviders()[0];
      expect(current?.version).toBe(2);
    } finally {
      left.close();
      right.close();
    }
  });
});
