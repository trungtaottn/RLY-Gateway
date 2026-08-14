import { describe, expect, it } from "vitest";
import {
  adapterIdForProvider,
  applyCatalogDefaults,
  PROVIDER_CATALOG,
  providerContract,
} from "../../../src/providers/catalog.js";

describe("provider catalog contracts", () => {
  it("declares ownership, isolation, and import mode for each planned provider", () => {
    const names = PROVIDER_CATALOG.map((item) => item.id);
    expect(names).toEqual(expect.arrayContaining([
      "gemini", "antigravity", "cline", "claude", "opencode-go", "alibaba", "codex",
    ]));
    expect(providerContract("gemini")).toMatchObject({
      ownership: "project-oauth",
      importMode: "explicit-readonly",
      adapterId: "gemini-oauth",
    });
    expect(providerContract("antigravity")).toMatchObject({
      ownership: "attested-bridge",
      localOnly: true,
      integrationMode: "bridge",
    });
    expect(providerContract("cline")).toMatchObject({
      ownership: "explicit-interop",
      importMode: "opt-in-interoperability",
      credentialProvider: "cline",
    });
    expect(providerContract("alibaba")).toMatchObject({
      termsGated: true, localOnly: true, defaultTermsRevision: "alibaba-terms-1",
    });
    expect(providerContract("claude")?.capabilities).toMatchObject({ streaming: false, tools: false });
    expect(adapterIdForProvider("gemini", "oauth")).toBe("gemini-oauth");
    expect(() => adapterIdForProvider("not-a-provider", "direct")).toThrow(/unknown provider/);
    expect(() => adapterIdForProvider("antigravity", "oauth")).toThrow(/unknown provider/);
    expect(() => applyCatalogDefaults({ name: "keep", integrationMode: "direct" })).toThrow(/unknown provider/);
    expect(() => applyCatalogDefaults({ name: "cline", integrationMode: "oauth" })).toThrow(/endpoint policy/);
    expect(() => applyCatalogDefaults({
      name: "cline", integrationMode: "oauth", endpointPolicy: "http://127.0.0.1:10100",
    })).toThrow(/protected port/);
    expect(applyCatalogDefaults({
      name: "cline", integrationMode: "oauth", endpointPolicy: "http://127.0.0.1:17874",
    }).endpointPolicy).toBe("http://127.0.0.1:17874");
    expect(JSON.stringify(PROVIDER_CATALOG)).not.toMatch(/accessToken|refreshToken|email/i);
  });
});
