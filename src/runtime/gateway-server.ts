import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { GatewayConfig } from "../config/schema.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import { createDirectRouteResolver, type ResolvedDirectRoute } from "../providers/direct/direct-upstream.js";
import { registerAnthropicMessagesRoute } from "../routes/anthropic-messages-route.js";
import { registerAnthropicDirectCountTokensRoute } from "../routes/anthropic-direct-count-tokens-route.js";

export type GatewayServerOptions = Readonly<{
  host: "127.0.0.1";
  port: number;
  authToken: string;
  instanceId: string;
  configFingerprint: string;
  config?: GatewayConfig;
  environment?: NodeJS.ProcessEnv;
  leases?: GatewayLeaseRegistry;
  resolveOauthRoute?: (request: CanonicalRequest) => Promise<ResolvedDirectRoute | undefined> | ResolvedDirectRoute | undefined;
}>;

export type GatewayLeaseRegistry = Readonly<{
  add: (leaseId: string) => Promise<void>;
  renew: (leaseId: string) => Promise<void>;
  release: (leaseId: string) => Promise<void>;
}>;

const leaseParamsSchema = z.object({ leaseId: z.uuid() });

function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, expected);
}

function isGatewayRequestAuthorized(headers: Readonly<{ authorization?: string | undefined; "x-api-key"?: string | string[] | undefined }>, token: string): boolean {
  if (isAuthorized(headers.authorization, token)) return true;
  const key = headers["x-api-key"];
  const candidate = Array.isArray(key) ? key[0] : key;
  if (candidate === undefined) return false;
  const actual = createHash("sha256").update(candidate).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, expected);
}

const challengePattern = /^[A-Za-z0-9_-]{32,128}$/;

export function createIdentityProof(
  authToken: string,
  challenge: string,
  instanceId: string,
  configFingerprint: string,
): string {
  return createHmac("sha256", authToken)
    .update(["agent-gateway", "1", challenge, instanceId, configFingerprint].join("\n"))
    .digest("hex");
}

export function createGatewayServer(options: GatewayServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  app.get("/healthz", () => ({ ok: true }));
  if (options.config && (Object.keys(options.config.routes).length > 0 || options.resolveOauthRoute)) {
    const resolveDirect = Object.keys(options.config.routes).length > 0
      ? createDirectRouteResolver(options.config, options.configFingerprint, options.environment)
      : undefined;
    const resolveRoute = async (request: CanonicalRequest) => {
      return resolveDirect?.(request) ?? await options.resolveOauthRoute?.(request);
    };
    registerAnthropicMessagesRoute(app, {
      configFingerprint: options.configFingerprint,
      resolveRoute,
    });
    registerAnthropicDirectCountTokensRoute(app, resolveRoute);
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/v1/") || isGatewayRequestAuthorized(request.headers, options.authToken)) return;
      await reply.code(401).send({ type: "error", error: { type: "authentication_error", message: "Gateway request is unauthorized" } });
    });
  }
  app.get("/readyz", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return { ready: true, routes: Object.keys(options.config?.routes ?? {}).length };
  });
  app.post<{ Params: { leaseId: string } }>("/leases/:leaseId", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!options.leases) return reply.code(503).send({ error: "leases-unavailable" });
    const parsed = leaseParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid-lease" });
    await options.leases.add(parsed.data.leaseId);
    return reply.code(201).send({ leased: true });
  });
  app.put<{ Params: { leaseId: string } }>("/leases/:leaseId", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!options.leases) return reply.code(503).send({ error: "leases-unavailable" });
    const parsed = leaseParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid-lease" });
    await options.leases.renew(parsed.data.leaseId);
    return { renewed: true };
  });
  app.delete<{ Params: { leaseId: string } }>("/leases/:leaseId", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!options.leases) return reply.code(503).send({ error: "leases-unavailable" });
    const parsed = leaseParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid-lease" });
    await options.leases.release(parsed.data.leaseId);
    return reply.code(204).send();
  });
  app.get<{ Querystring: { challenge?: string } }>("/identity", async (request, reply) => {
    const challenge = request.query.challenge;
    if (!challenge || !challengePattern.test(challenge)) {
      return reply.code(400).send({ error: "invalid-challenge" });
    }
    return {
      product: "agent-gateway",
      instanceId: options.instanceId,
      configFingerprint: options.configFingerprint,
      protocolVersion: 1,
      proof: createIdentityProof(
        options.authToken,
        challenge,
        options.instanceId,
        options.configFingerprint,
      ),
    };
  });
  return app;
}

export async function listenGateway(app: FastifyInstance, options: GatewayServerOptions): Promise<string> {
  return app.listen({ host: options.host, port: options.port });
}
