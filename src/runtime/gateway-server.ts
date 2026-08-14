import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { GatewayConfig } from "../config/schema.js";
import type { CapabilityRequirement } from "../core/capabilities.js";
import type { CanonicalRequest } from "../core/canonical-request.js";
import type { ControlPlaneStore } from "../control-plane/store.js";
import type { CredentialBroker } from "../credentials/broker.js";
import { registerLaunchSessionRoutes } from "../profiles/http.js";
import { resolveProfileRoute } from "../profiles/resolve-route.js";
import type { LaunchSessionRegistry } from "../profiles/sessions.js";
import type { RouteTraceRing } from "../profiles/traces.js";
import { createDirectRouteResolver, type ResolvedDirectRoute } from "../providers/direct/direct-upstream.js";
import { ResponseContinuationStore } from "../protocols/openai-responses/continuation.js";
import { registerAnthropicMessagesRoute } from "../routes/anthropic-messages-route.js";
import { registerAnthropicDirectCountTokensRoute } from "../routes/anthropic-direct-count-tokens-route.js";
import { registerOpenAiResponsesRoute } from "../routes/openai-responses-route.js";
import type { RouteSelector } from "../routing/pools/selector.js";
import { RUNTIME_VERSION } from "./gateway-attestation.js";

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
  controlPlane?: ControlPlaneStore;
  broker?: CredentialBroker;
  selector?: RouteSelector;
  launchSessions?: LaunchSessionRegistry;
  traces?: RouteTraceRing;
  continuationDirectory?: string;
  /** True when this instance is owned by the per-user resident service. */
  resident?: boolean;
  /** Authenticated in-process shutdown used by the explicit service stop path. */
  shutdown?: () => Promise<void>;
}>;

export type GatewayLeaseRegistry = Readonly<{
  add: (leaseId: string) => Promise<void>;
  renew: (leaseId: string) => Promise<void>;
  release: (leaseId: string) => Promise<void>;
  has?: (leaseId: string) => boolean;
}>;

const leaseParamsSchema = z.object({ leaseId: z.uuid() });
type RequestHeaders = Readonly<{ authorization?: string | undefined; "x-api-key"?: string | string[] | undefined }>;

function tokensEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest());
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function isAuthorized(header: string | undefined, token: string): boolean {
  const value = bearerToken(header);
  return value !== undefined && tokensEqual(value, token);
}

function headerToken(headers: RequestHeaders): string | undefined {
  const fromAuth = bearerToken(headers.authorization);
  if (fromAuth) return fromAuth;
  const key = headers["x-api-key"];
  return Array.isArray(key) ? key[0] : key;
}

function isGatewayRequestAuthorized(headers: RequestHeaders, token: string): boolean {
  const candidate = headerToken(headers);
  return candidate !== undefined && tokensEqual(candidate, token);
}

const challengePattern = /^[A-Za-z0-9_-]{32,128}$/;

export function createIdentityProof(
  authToken: string,
  challenge: string,
  instanceId: string,
  configFingerprint: string,
): string {
  return createHmac("sha256", authToken)
    .update(["rly-gateway", "1", challenge, instanceId, configFingerprint].join("\n"))
    .digest("hex");
}

export function createGatewayServer(options: GatewayServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  app.get("/healthz", () => ({ ok: true }));
  const controlPlane = options.controlPlane;
  const broker = options.broker;
  const selector = options.selector;
  const launchSessions = options.launchSessions;
  const traces = options.traces;
  const profileReady = controlPlane !== undefined
    && broker !== undefined
    && selector !== undefined
    && launchSessions !== undefined
    && traces !== undefined;
  const hasRoutes = Boolean(options.config && (Object.keys(options.config.routes).length > 0 || options.resolveOauthRoute || profileReady));
  if (hasRoutes && options.config) {
    const resolveDirect = Object.keys(options.config.routes).length > 0
      ? createDirectRouteResolver(options.config, options.configFingerprint, options.environment)
      : undefined;
    const resolveRoute = async (
      request: CanonicalRequest,
      headers?: RequestHeaders,
      required?: readonly CapabilityRequirement[],
    ) => {
      const token = headerToken(headers ?? {});
      const session = token === undefined ? undefined : launchSessions?.resolve(token);
      // Profile/pool session first, then TOML routes, then Codex pin.
      if (session && controlPlane && broker && selector && traces) {
        return resolveProfileRoute(request, session, {
          store: controlPlane,
          broker,
          selector,
          traces,
          configFingerprint: options.configFingerprint,
          ...(options.environment === undefined ? {} : { environment: options.environment }),
          ...(required === undefined ? {} : { required }),
        });
      }
      return resolveDirect?.(request) ?? await options.resolveOauthRoute?.(request);
    };
    const continuationDirectory = options.continuationDirectory ?? options.controlPlane?.directory;
    const continuation = continuationDirectory === undefined ? undefined : new ResponseContinuationStore(continuationDirectory);
    registerAnthropicMessagesRoute(app, {
      configFingerprint: options.configFingerprint,
      resolveRoute,
    });
    registerOpenAiResponsesRoute(app, {
      configFingerprint: options.configFingerprint,
      resolveRoute,
      ...(continuation === undefined ? {} : { continuation }),
    });
    registerAnthropicDirectCountTokensRoute(app, resolveRoute);
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/v1/")) return;
      const token = headerToken(request.headers);
      if (isGatewayRequestAuthorized(request.headers, options.authToken)) return;
      if (token && launchSessions?.resolve(token)) return;
      await reply.code(401).send({ type: "error", error: { type: "authentication_error", message: "Gateway request is unauthorized" } });
    });
  }
  if (controlPlane && launchSessions && traces) {
    registerLaunchSessionRoutes(app, {
      store: controlPlane,
      sessions: launchSessions,
      traces,
      isInstanceToken: (token) => token !== undefined && isGatewayRequestAuthorized({ authorization: `Bearer ${token}` }, options.authToken),
      resolveSession: (token) => token === undefined ? undefined : launchSessions.resolve(token),
      extractToken: headerToken,
      ...(options.leases?.has === undefined ? {} : { leaseActive: (leaseId) => options.leases?.has?.(leaseId) === true }),
    });
  }
  const authorizeLease = async (
    request: { headers: RequestHeaders; params: { leaseId: string } },
    reply: { code: (status: number) => { send: (payload?: unknown) => unknown } },
  ) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      await reply.code(401).send({ error: "unauthorized" });
      return undefined;
    }
    if (!options.leases) {
      await reply.code(503).send({ error: "leases-unavailable" });
      return undefined;
    }
    const parsed = leaseParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      await reply.code(400).send({ error: "invalid-lease" });
      return undefined;
    }
    return { leaseId: parsed.data.leaseId, leases: options.leases };
  };
  app.get("/readyz", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return { ready: true, routes: Object.keys(options.config?.routes ?? {}).length };
  });
  app.post("/shutdown", async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, options.authToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (!options.shutdown) {
      return reply.code(503).send({ error: "shutdown-unavailable" });
    }
    // Reply before closing so the shutdown request completes; the bounded close
    // then drains only connections owned by this server.
    reply.code(202).send({ shuttingDown: true });
    setImmediate(() => { void options.shutdown?.(); });
  });
  app.post<{ Params: { leaseId: string } }>("/leases/:leaseId", async (request, reply) => {
    const lease = await authorizeLease(request, reply);
    if (!lease) return;
    await lease.leases.add(lease.leaseId);
    return reply.code(201).send({ leased: true });
  });
  app.put<{ Params: { leaseId: string } }>("/leases/:leaseId", async (request, reply) => {
    const lease = await authorizeLease(request, reply);
    if (!lease) return;
    await lease.leases.renew(lease.leaseId);
    return { renewed: true };
  });
  app.delete<{ Params: { leaseId: string } }>("/leases/:leaseId", async (request, reply) => {
    const lease = await authorizeLease(request, reply);
    if (!lease) return;
    options.launchSessions?.dropLease(lease.leaseId);
    await lease.leases.release(lease.leaseId);
    return reply.code(204).send();
  });
  app.get<{ Querystring: { challenge?: string } }>("/identity", async (request, reply) => {
    const challenge = request.query.challenge;
    if (!challenge || !challengePattern.test(challenge)) {
      return reply.code(400).send({ error: "invalid-challenge" });
    }
    return {
      product: "rly-gateway",
      instanceId: options.instanceId,
      configFingerprint: options.configFingerprint,
      protocolVersion: 1,
      runtimeVersion: RUNTIME_VERSION,
      ...(options.resident === undefined ? {} : { resident: options.resident }),
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
