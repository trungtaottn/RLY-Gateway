import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

export type GatewayServerOptions = Readonly<{
  host: "127.0.0.1";
  port: number;
  authToken: string;
  instanceId: string;
  configFingerprint: string;
  leases?: GatewayLeaseRegistry;
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
  app.get("/readyz", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return { ready: true, routes: 0 };
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
