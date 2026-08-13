import { describe, expect, it } from "vitest";
import { fingerprintConfig } from "../../src/config/config-fingerprint.js";
import { gatewayConfigSchema, validateCredentialRefs } from "../../src/config/schema.js";

describe("gateway config", () => {
  it("accepts loopback config with secret references", () => {
    const config = gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { host: "127.0.0.1", port: 17871, logLevel: "info" },
      routes: { primary: { provider: "openrouter", model: "model", credential: "env:OPENROUTER_API_KEY" } },
    });
    expect(() => validateCredentialRefs(config)).not.toThrow();
  });

  it("rejects non-loopback binding", () => {
    expect(() => gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { host: "0.0.0.0", port: 17871 },
    })).toThrow();
  });

  it.each([10100, 8317, 17870])("rejects protected port %i", (port) => {
    expect(() => gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { host: "127.0.0.1", port },
    })).toThrow("Protected port");
  });

  it("creates a stable config fingerprint independent of key order", () => {
    const left = gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { host: "127.0.0.1", port: 17871, logLevel: "info" },
      routes: {
        primary: { provider: "openrouter", model: "model", credential: "env:OPENROUTER_API_KEY" },
      },
    });
    const right = gatewayConfigSchema.parse({
      routes: {
        primary: { credential: "env:OPENROUTER_API_KEY", model: "model", provider: "openrouter" },
      },
      gateway: { logLevel: "info", port: 17871, host: "127.0.0.1" },
      schemaVersion: 1,
    });
    expect(fingerprintConfig(left)).toBe(fingerprintConfig(right));
  });

  it("rejects a credential reference owned by another provider", () => {
    const config = gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { host: "127.0.0.1", port: 17871 },
      routes: { primary: { provider: "openrouter", model: "model", credential: "env:DEEPSEEK_API_KEY" } },
    });
    expect(() => validateCredentialRefs(config)).toThrow("not approved");
  });

  it("does not echo a malformed credential value", () => {
    const malformed = "value-that-must-not-appear-in-diagnostics";
    const config = gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { host: "127.0.0.1", port: 17871 },
      routes: { primary: { provider: "openrouter", model: "model", credential: malformed } },
    });
    try {
      validateCredentialRefs(config);
      throw new Error("Expected credential validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(malformed);
    }
  });

  it("does not echo a secret-like environment reference name", () => {
    const secretLikeName = "LOOKS_LIKE_A_RAW_SECRET_123456789";
    const config = gatewayConfigSchema.parse({
      schemaVersion: 1,
      gateway: { host: "127.0.0.1", port: 17871 },
      routes: {
        primary: {
          provider: "openrouter",
          model: "model",
          credential: `env:${secretLikeName}`,
        },
      },
    });
    try {
      validateCredentialRefs(config);
      throw new Error("Expected credential validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secretLikeName);
      expect((error as Error).message).toBe("Credential reference is not approved for the selected provider");
    }
  });

  it("accepts only declared model roles", () => {
    expect(() => gatewayConfigSchema.parse({
      schemaVersion: 1, gateway: { port: 17871 },
      routes: { experimental: { provider: "openrouter", model: "fixture", credential: "env:OPENROUTER_API_KEY" } },
    })).toThrow();
  });
});
