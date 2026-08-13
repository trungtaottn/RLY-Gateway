import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createGatewayServer } from "../../src/runtime/gateway-server.js";

let upstream: FastifyInstance | undefined;
let gateway: FastifyInstance | undefined;

afterEach(async () => { await gateway?.close(); await upstream?.close(); gateway = undefined; upstream = undefined; });

async function setup(): Promise<void> {
  upstream = Fastify();
  upstream.post("/chat/completions", async (request, reply) => {
    const body = request.body as { stream?: boolean };
    if (body.stream) return await reply.header("content-type", "text/event-stream").send("data: {\"id\":\"fixture-stream\",\"choices\":[{\"delta\":{\"content\":\"fixture\"}}]}\n\ndata: {\"id\":\"fixture-stream\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n");
    return { id: "fixture-text", choices: [{ finish_reason: "stop", message: { content: "fixture" } }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
  });
  const upstreamBase = await upstream.listen({ host: "127.0.0.1", port: 0 });
  gateway = createGatewayServer({
    host: "127.0.0.1", port: 17871, authToken: "gateway-fixture", instanceId: "00000000-0000-4000-8000-000000000001", configFingerprint: "a".repeat(64),
    environment: { OPENROUTER_API_KEY: "fixture-key" },
    config: { schemaVersion: 1, gateway: { host: "127.0.0.1", port: 17871, logLevel: "silent" }, routes: { primary: { provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free", credential: "env:OPENROUTER_API_KEY", baseUrl: upstreamBase }, fast: { provider: "openrouter", model: "nvidia/nemotron-nano-12b-v2-vl:free", credential: "env:OPENROUTER_API_KEY", baseUrl: upstreamBase } } },
  });
}

describe("direct provider runtime", () => {
  it("maps explicit role to authenticated text, streaming, and token-count endpoints", async () => {
    await setup();
    const headers = { "x-api-key": "gateway-fixture" };
    const body = { model: "primary", max_tokens: 8, messages: [{ role: "user", content: "fixture" }] };
    if (!gateway) throw new Error("gateway test fixture was not initialized");
    const [text, stream, count] = await Promise.all([
      gateway.inject({ method: "POST", url: "/v1/messages", headers, payload: body }),
      gateway.inject({ method: "POST", url: "/v1/messages", headers, payload: { ...body, stream: true } }),
      gateway.inject({ method: "POST", url: "/v1/messages/count_tokens", headers, payload: body }),
    ]);
    expect(text.statusCode).toBe(200); expect(text.json()).toMatchObject({ model: "nvidia/nemotron-3.5-lightning:free", content: [{ type: "text", text: "fixture" }] });
    expect(stream.statusCode).toBe(200); expect(stream.body).toContain("message_stop");
    expect(count.headers["x-agent-gateway-token-count-quality"]).toBe("conservative-estimate");
  });

  it("maps known Claude helper models to configured fast and primary routes", async () => {
    await setup();
    if (!gateway) throw new Error("gateway test fixture was not initialized");
    const headers = { "x-api-key": "gateway-fixture" };
    const body = { max_tokens: 8, messages: [{ role: "user", content: "fixture" }] };
    const [fast, primary] = await Promise.all([
      gateway.inject({ method: "POST", url: "/v1/messages", headers, payload: { ...body, model: "claude-haiku-4-5" } }),
      gateway.inject({ method: "POST", url: "/v1/messages", headers, payload: { ...body, model: "claude-sonnet-5" } }),
    ]);
    expect(fast.statusCode).toBe(200); expect(fast.json()).toMatchObject({ model: "nvidia/nemotron-nano-12b-v2-vl:free" });
    expect(primary.statusCode).toBe(200); expect(primary.json()).toMatchObject({ model: "nvidia/nemotron-3.5-lightning:free" });
  });
});
