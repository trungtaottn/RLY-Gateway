import { describe, expect, it } from "vitest";
import { assertProviderCredential, parseCredentialRef } from "../../src/credentials/credential-ref.js";
import { resolveEnvironmentCredential } from "../../src/credentials/env-resolver.js";

describe("credential references", () => {
  it("parses approved environment references", () => {
    expect(parseCredentialRef("env:OPENROUTER_API_KEY")).toEqual({ kind: "env", name: "OPENROUTER_API_KEY" });
  });

  it("rejects unsupported reference kinds", () => {
    expect(() => parseCredentialRef("raw:do-not-store-this")).toThrow("Unsupported credential reference kind");
  });

  it("rejects syntactically valid but unapproved environment references", () => {
    expect(() => assertProviderCredential("openrouter", { kind: "env", name: "PATH" })).toThrow("not approved");
    expect(() => assertProviderCredential("openrouter", { kind: "env", name: "AWS_SECRET_ACCESS_KEY" })).toThrow("not approved");
    expect(() => assertProviderCredential("openrouter", { kind: "env", name: "OPENROUTER_API_KEY" })).not.toThrow();
  });

  it("never serializes the secret and supports disposal", () => {
    const handle = resolveEnvironmentCredential(
      { kind: "env", name: "TEST_SECRET_KEY" },
      { TEST_SECRET_KEY: "sensitive-value" },
    );
    expect(handle.reveal()).toBe("sensitive-value");
    expect(JSON.stringify(handle)).toBe('"[REDACTED]"');
    expect(String(handle)).toBe("[REDACTED]");
    handle.dispose();
    expect(() => handle.reveal()).toThrow("disposed");
  });
});
