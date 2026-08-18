import { describe, expect, it, vi } from "vitest";
import type { DiscoverySnapshot } from "../../../src/registry/model-registry.js";
import {
  OpenRouterCatalogSource,
  StaticCatalogSource,
  createCatalogSource,
  normalizeOpenRouterModel,
  redactUpstreamError,
} from "../../../src/providers/catalog-discovery.js";

describe("catalog discovery sources (#23)", () => {
  it("normalizes an OpenRouter /models payload into a discovery snapshot without registry access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { id: "nvidia/nemotron-3.5-lightning:free", context_length: 200_000, supported_parameters: ["tools", "reasoning", "max_tokens"] },
        { id: "openai/gpt-oss-20b:free" },
        { id: "gpt-5.4" },
      ],
    }), { status: 200 }));
    const source = new OpenRouterCatalogSource({ request: fetch });
    const snapshot = await source.discover(new AbortController().signal);
    expect(snapshot.source).toBe("openrouter-api-v1");
    expect(snapshot.models).toHaveLength(3);
    expect(snapshot.models[0]).toEqual({
      accessProviderId: "openrouter",
      upstreamModelId: "nvidia/nemotron-3.5-lightning:free",
      modelFamily: "nvidia",
      declared: { contextWindow: 200_000, tools: true, reasoning: true },
    });
    expect(snapshot.models[1]).toEqual({ accessProviderId: "openrouter", upstreamModelId: "openai/gpt-oss-20b:free", modelFamily: "openai" });
    // No slash -> no guessed family; casing preserved as-is.
    expect(snapshot.models[2]).toEqual({ accessProviderId: "openrouter", upstreamModelId: "gpt-5.4" });
    expect(fetch).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", expect.any(Object));
  });

  it("uses an approved env credential ref for authenticated catalogs and never serializes the secret", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "x/y" }] }), { status: 200 }));
    const source = new OpenRouterCatalogSource({ request: fetch, environment: { OPENROUTER_API_KEY: "fixture-secret" }, credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" } });
    const snapshot = await source.discover(new AbortController().signal);
    const options = fetch.mock.calls[0]?.[1];
    expect(options?.headers).toMatchObject({ authorization: "Bearer fixture-secret" });
    expect(JSON.stringify(snapshot)).not.toContain("fixture-secret");
    expect(JSON.stringify(snapshot)).not.toContain("authorization");
  });

  it("reports actionable, privacy-redacted errors for upstream failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ error: "token=super-secret-abc email=admin@example.com bearer xyz789" }),
      { status: 500 },
    )));
    const source = new OpenRouterCatalogSource({ request: fetch });
    await expect(source.discover(new AbortController().signal)).rejects.toMatchObject({
      name: "CatalogDiscoveryError",
      code: "api_error",
    });
    await expect(source.discover(new AbortController().signal)).rejects.toThrow(/\[REDACTED\]/);
    await expect(source.discover(new AbortController().signal)).rejects.not.toThrow(/super-secret-abc/);
    await expect(source.discover(new AbortController().signal)).rejects.not.toThrow(/admin@example/);
    await expect(source.discover(new AbortController().signal)).rejects.not.toThrow(/xyz789/);
  });

  it("classifies authentication and rate-limit failures and rejects malformed payloads", async () => {
    const auth = new OpenRouterCatalogSource({ request: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 401 })) });
    await expect(auth.discover(new AbortController().signal)).rejects.toMatchObject({ code: "authentication_error" });
    const limited = new OpenRouterCatalogSource({ request: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 429 })) });
    await expect(limited.discover(new AbortController().signal)).rejects.toMatchObject({ code: "rate_limit_error" });
    const notJson = new OpenRouterCatalogSource({ request: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not-json", { status: 200 })) });
    await expect(notJson.discover(new AbortController().signal)).rejects.toMatchObject({ code: "invalid-response" });
    const wrongShape = new OpenRouterCatalogSource({ request: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ name: "missing-id" }] }), { status: 200 })) });
    await expect(wrongShape.discover(new AbortController().signal)).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("normalizes provider rules without guessing equivalence from similar names", () => {
    expect(normalizeOpenRouterModel({ id: "anthropic/claude-sonnet-5:beta" }).modelFamily).toBe("anthropic");
    expect(normalizeOpenRouterModel({ id: "deepseek/deepseek-chat", supported_parameters: ["reasoning"] }).declared).toEqual({ reasoning: true });
    // No slash -> no family; casing untouched.
    expect(normalizeOpenRouterModel({ id: "GPT-5.4" }).modelFamily).toBeUndefined();
    expect(normalizeOpenRouterModel({ id: "GPT-5.4" }).upstreamModelId).toBe("GPT-5.4");
    expect(() => normalizeOpenRouterModel({})).toThrow(/missing model id/);
  });

  it("redacts bearer tokens, credential-shaped pairs, and email addresses", () => {
    expect(redactUpstreamError("Bearer sk-abcd1234 unauthorized")).toBe("Bearer [REDACTED] unauthorized");
    expect(redactUpstreamError("api_key=zzz password=hunter2")).toBe("api_key=[REDACTED] password=[REDACTED]");
    expect(redactUpstreamError("contact admin@example.com now")).toBe("contact [REDACTED-EMAIL] now");
  });

  it("serves a validated static snapshot and fails closed on a malformed one", async () => {
    const snapshot: DiscoverySnapshot = Object.freeze({
      source: "reviewed-list",
      discoveredAt: "2026-08-22T00:00:00.000Z",
      models: Object.freeze([Object.freeze({ accessProviderId: "deepseek", upstreamModelId: "deepseek-v4-flash", modelFamily: "deepseek" })]),
    });
    const source = new StaticCatalogSource("deepseek", snapshot);
    await expect(source.discover(new AbortController().signal)).resolves.toEqual(snapshot);
    const malformed = new StaticCatalogSource("deepseek", { source: "x", discoveredAt: "", models: [] });
    await expect(malformed.discover(new AbortController().signal)).rejects.toMatchObject({ code: "invalid-snapshot" });
  });

  it("dispatches api vs static sources with actionable errors", () => {
    expect(createCatalogSource("openrouter").sourceId).toBe("openrouter-api-v1");
    expect(() => createCatalogSource("deepseek")).toThrow(/requires a snapshot/);
    expect(() => createCatalogSource("deepseek", { source: "api" })).toThrow(/no API catalog source for provider deepseek/);
    const staticSource = createCatalogSource("deepseek", { source: "static", snapshot: { source: "s", discoveredAt: "2026-08-22T00:00:00.000Z", models: [] } });
    expect(staticSource.sourceId).toBe("static");
    expect(staticSource.providerId).toBe("deepseek");
  });
});
