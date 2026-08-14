import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProposalStore } from "../../src/registry/proposal-store.js";
import { proposeCatalogDrift } from "../../src/registry/catalog-proposal.js";
import { MODEL_REGISTRY_REVISION, type DiscoverySnapshot, type RegistryDocument } from "../../src/registry/model-registry.js";
import { catalogProposalReportSchema } from "../../src/registry/catalog-proposal.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempControlPlane(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rly-gateway-proposal-store-"));
  directories.push(directory);
  return directory;
}

const registry: RegistryDocument = Object.freeze({
  registryRevision: MODEL_REGISTRY_REVISION,
  models: Object.freeze([
    Object.freeze({
      logicalId: "openrouter/nvidia/nemotron-3.5-lightning:free",
      identity: Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia" }),
      verifiedAt: "2026-08-13",
      fixtureVersion: "openai-chat-v1",
      tokenCounting: "conservative-estimate" as const,
      capabilities: Object.freeze({
        streaming: true, tools: true, parallelTools: false, images: false, reasoning: true,
        redactedReasoning: false, structuredOutput: false, tokenCounting: "conservative-estimate" as const,
      }),
      limits: Object.freeze({}),
      reasoning: Object.freeze({ supported: true, controlKind: "binary" as const, adaptive: false, tokenBudget: false, reasoningWithTools: false }),
      compatibility: Object.freeze({ state: "EXPERIMENTAL" as const, baseline: "claude-code-fake-upstream", evidenceRef: "e2e-1", checkedAt: "2026-08-13" }),
    }),
  ]),
});

function snapshot(): DiscoverySnapshot {
  return Object.freeze({
    source: "openrouter-api-v1",
    discoveredAt: "2026-08-22T00:00:00.000Z",
    models: Object.freeze([
      Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "nvidia/nemotron-3.5-lightning:free", modelFamily: "nvidia" }),
      Object.freeze({ accessProviderId: "openrouter", upstreamModelId: "new/candidate:free", modelFamily: "new" }),
    ]),
  });
}

describe("proposal store (#23)", () => {
  it("persists a proposal artifact separately from trusted evidence and round-trips it", async () => {
    const directory = await tempControlPlane();
    const store = new ProposalStore(directory);
    const report = proposeCatalogDrift(snapshot(), "openrouter", registry);
    const path = await store.write(report);
    expect(path.endsWith(join("proposals", "openrouter.json"))).toBe(true);
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toEqual(report);
    expect(catalogProposalReportSchema.safeParse(JSON.parse(text) as unknown).success).toBe(true);
    await expect(store.read("openrouter")).resolves.toEqual(report);
    await expect(store.list()).resolves.toEqual([report]);
    // The trusted registry the report was diffed against is untouched.
    expect(registry.models).toHaveLength(1);
    expect(Object.isFrozen(registry.models)).toBe(true);
  });

  it("lists proposals deterministically across providers", async () => {
    const directory = await tempControlPlane();
    const store = new ProposalStore(directory);
    await store.write(proposeCatalogDrift(snapshot(), "openrouter", registry));
    await store.write(proposeCatalogDrift(Object.freeze({
      source: "reviewed-list",
      discoveredAt: "2026-08-22T00:00:00.000Z",
      models: Object.freeze([Object.freeze({ accessProviderId: "deepseek", upstreamModelId: "deepseek-v4-flash" })]),
    }), "deepseek", registry));
    const listed = await store.list();
    expect(listed.map((report) => report.providerId)).toEqual(["deepseek", "openrouter"]);
  });

  it("returns an empty list when no proposals exist", async () => {
    const directory = await tempControlPlane();
    await expect(new ProposalStore(directory).list()).resolves.toEqual([]);
  });

  it("fails closed on a malformed artifact instead of trusting it", async () => {
    const directory = await tempControlPlane();
    const store = new ProposalStore(directory);
    await store.write(proposeCatalogDrift(snapshot(), "openrouter", registry));
    await writeFile(join(directory, "proposals", "openrouter.json"), '{"not":"a report"}', "utf8");
    await expect(store.list()).rejects.toThrow(/failed schema validation/);
    await expect(store.read("openrouter")).rejects.toThrow(/failed schema validation/);
  });

  it("keeps credentials and account identity out of the persisted artifact", async () => {
    const directory = await tempControlPlane();
    const store = new ProposalStore(directory);
    await store.write(proposeCatalogDrift(snapshot(), "openrouter", registry));
    const text = await readFile(join(directory, "proposals", "openrouter.json"), "utf8");
    const forbidden = new Set(["accessToken", "refreshToken", "authorization", "token", "secret", "password", "email", "prompt", "response", "pseudonym", "credentialHandle"]);
    const walk = (value: unknown, path: string): string[] => {
      if (value === null || typeof value !== "object") return [];
      const findings: string[] = [];
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key)) findings.push(`${path}.${key}`);
        findings.push(...walk(child, `${path}.${key}`));
      }
      return findings;
    };
    expect(walk(JSON.parse(text), "artifact")).toEqual([]);
  });
});
