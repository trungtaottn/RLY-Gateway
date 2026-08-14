import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeCanonicalUpstream } from "../../../src/protocols/anthropic/fake-upstream.js";
import { launchCodex } from "../../../src/runtime/child-launcher.js";
import { createGatewayServer } from "../../../src/runtime/gateway-server.js";

const clientPath = join(dirname(fileURLToPath(import.meta.url)), "fake-client.mjs");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex fake-upstream E2E", () => {
  it("launches an isolated Codex child through Responses and a fake upstream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-gateway-codex-e2e-"));
    directories.push(directory);
    const app = createGatewayServer({
      host: "127.0.0.1",
      port: 17874,
      authToken: "transient-e2e-token",
      instanceId: "00000000-0000-4000-8000-000000000001",
      configFingerprint: "a".repeat(64),
      continuationDirectory: directory,
      config: {
        schemaVersion: 1,
        gateway: { host: "127.0.0.1", port: 17874, managementPort: 17875, logLevel: "silent" },
        controlPlane: {},
        routes: {},
      },
      resolveOauthRoute: () => ({
        route: {
          role: "primary",
          providerId: "fake",
          modelId: "primary",
          adapterId: "fake",
          credentialRef: { kind: "env", name: "OPENROUTER_API_KEY" },
          capabilities: {
            streaming: true, tools: true, parallelTools: false, images: false,
            reasoning: true, redactedReasoning: false, structuredOutput: false,
            tokenCounting: "exact-local",
          },
        },
        upstream: new FakeCanonicalUpstream(),
      }),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const exit = await launchCodex({
        gatewayBaseUrl: address,
        authToken: "transient-e2e-token",
        executable: process.execPath,
        args: [clientPath],
        environment: { HOME: directory, PATH: "/bin" },
      });
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      await app.close();
    }
  });
});
