import { describe, expect, it } from "vitest";
import { gatewayConfigSchema } from "../../src/config/schema.js";
import { directProviderRegistry, resolveConfiguredRoute, routesFromConfig } from "../../src/registry/model-registry.js";

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
    expect(directProviderRegistry.models.at(-1)?.capabilities.tools).toBe(false);
  });

  it("refuses routes that lack reviewed model evidence", () => {
    const config = gatewayConfigSchema.parse({ schemaVersion: 1, gateway: { port: 17871 }, routes: { primary: { provider: "openrouter", model: "unreviewed-model", credential: "env:OPENROUTER_API_KEY" } } });
    expect(routesFromConfig(config).size).toBe(0);
  });
});
