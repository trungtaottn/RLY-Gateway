import { describe, expect, it } from "vitest";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import { directProviderRegistry, findModelEvidence, resolveConfiguredRoute, routesFromConfig } from "../../src/registry/model-registry.js";

describe("model registry", () => {
  it("maps explicit routes and known Claude internal models to fixed configured roles", () => {
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871 }, routes: { primary: { provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free", credential: "env:OPENROUTER_API_KEY" }, fast: { provider: "openrouter", model: "nvidia/nemotron-nano-12b-v2-vl:free", credential: "env:OPENROUTER_API_KEY" } } });
    const routes = routesFromConfig(config);
    expect(resolveConfiguredRoute(routes, "primary")?.modelId).toBe("nvidia/nemotron-3.5-lightning:free");
    expect(resolveConfiguredRoute(routes, "nvidia/nemotron-nano-12b-v2-vl:free")?.role).toBe("fast");
    expect(resolveConfiguredRoute(routes, "claude-haiku-4-5")?.role).toBe("fast");
    expect(resolveConfiguredRoute(routes, "claude-sonnet-5")?.role).toBe("primary");
    expect(resolveConfiguredRoute(routes, "claude-opus-4-8")?.role).toBe("primary");
    expect(resolveConfiguredRoute(routes, "claude-haiku-unknown")).toBeUndefined();
    expect(resolveConfiguredRoute(routes, "claude-sonnet-not-real")).toBeUndefined();
    expect(resolveConfiguredRoute(routes, "unknown-model")).toBeUndefined();
    expect(Object.isFrozen(routes.get("primary")?.capabilities)).toBe(true);
    const deepseek = directProviderRegistry.models.find((model) => model.logicalId === "deepseek/deepseek-v4-flash");
    expect(deepseek?.capabilities.tools).toBe(false);
    const codex = directProviderRegistry.models.find((model) => model.logicalId === "codex/gpt-5.4");
    expect(codex?.capabilities.streaming).toBe(true);
    expect(codex?.capabilities.tools).toBe(true);
    expect(codex?.capabilities.images).toBe(false);
  });

  it("refuses routes that lack reviewed model evidence", () => {
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871 }, routes: { primary: { provider: "openrouter", model: "unreviewed-model", credential: "env:OPENROUTER_API_KEY" } } });
    expect(routesFromConfig(config).size).toBe(0);
  });

  it("does not publish OpenCode Go or Alibaba TOML routes without reviewed model evidence", () => {
    const logicalIds = directProviderRegistry.models.map((model) => model.logicalId);
    expect(logicalIds.some((id) => id.startsWith("opencode-go/") || id.startsWith("alibaba/"))).toBe(false);
    const config = gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { port: 17871 },
      routes: {
        primary: { provider: "opencode-go", model: "go-unreviewed", credential: "env:OPENCODE_API_KEY" },
        fast: { provider: "alibaba", model: "qwen-unreviewed", credential: "env:DASHSCOPE_API_KEY" },
      },
    });
    expect(routesFromConfig(config).size).toBe(0);
  });

  it("matches Codex evidence only for exact provider and model ids", () => {
    expect(findModelEvidence(directProviderRegistry, "codex", "gpt-5.4")?.logicalId).toBe("codex/gpt-5.4");
    expect(findModelEvidence(directProviderRegistry, "openrouter", "gpt-5.4")).toBeUndefined();
    expect(findModelEvidence(directProviderRegistry, "codex", "nvidia/nemotron-3.5-lightning:free")).toBeUndefined();
    expect(findModelEvidence(directProviderRegistry, "codex", "gpt-unreviewed")).toBeUndefined();
  });
});
