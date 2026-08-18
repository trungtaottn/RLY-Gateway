import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";

const enabled = process.env["RLY_LIVE_SMOKE"] === "1";
let gateway: FastifyInstance | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

describe.skipIf(!enabled)("OpenRouter live direct route", () => {
  it("records text, stream, token count and a forced tool call through the gateway", async () => {
    gateway = createGatewayServer({
      host: "127.0.0.1",
      port: 17872,
      authToken: "live-smoke-transient",
      instanceId: "live-smoke",
      configFingerprint: "live-smoke",
      environment: process.env,
      config: {
        schemaVersion: 1,
        gateway: { host: "127.0.0.1", port: 17872, managementPort: 17873, logLevel: "silent" },
        controlPlane: {},
        routes: {
          primary: {
            provider: "openrouter",
            model: "nvidia/nemotron-3.5-lightning:free",
            credential: "env:OPENROUTER_API_KEY",
          },
          fast: {
            provider: "openrouter",
            model: "nvidia/nemotron-nano-12b-v2-vl:free",
            credential: "env:OPENROUTER_API_KEY",
          },
        },
      },
    });
    const headers = { "x-api-key": "live-smoke-transient" };
    const textBody = { model: "primary", max_tokens: 64, messages: [{ role: "user", content: "Reply exactly LIVE_TEXT_OK." }] };
    const [text, stream, count, tool] = await Promise.all([
      gateway.inject({ method: "POST", url: "/v1/messages", headers, payload: textBody }),
      gateway.inject({ method: "POST", url: "/v1/messages", headers, payload: { ...textBody, stream: true } }),
      gateway.inject({ method: "POST", url: "/v1/messages/count_tokens", headers, payload: textBody }),
      gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers,
      payload: {
        model: "fast",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "Call echo_name." }],
        tools: [{ name: "echo_name", description: "Echo a name", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
        tool_choice: { type: "tool", name: "echo_name" },
      },
      }),
    ]);
    const textJson = JSON.parse(text.body) as { stop_reason?: unknown; usage?: unknown };
    const countJson = JSON.parse(count.body) as { input_tokens?: unknown };
    expect(text.statusCode).toBe(200);
    expect(textJson.stop_reason).toBe("end_turn");
    expect(textJson.usage).toEqual(expect.any(Object));
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain("message_start");
    expect(stream.body).toContain("message_stop");
    expect(count.statusCode).toBe(200);
    expect(count.headers["x-rly-gateway-token-count-quality"]).toBe("conservative-estimate");
    expect(countJson.input_tokens).toEqual(expect.any(Number));
    expect(tool.statusCode).toBe(200);
    expect(tool.body).toContain('"type":"tool_use"');
    expect(tool.body).toContain('"stop_reason":"tool_use"');
    expect(tool.body).toContain("message_stop");
  }, 60_000);
});
