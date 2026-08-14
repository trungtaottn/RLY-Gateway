import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ControlPlaneStore } from "../control-plane/store.js";
import { CredentialBroker } from "../credentials/broker.js";
import { CredentialService } from "../credentials/service.js";
import { createManagementServer, listenManagement } from "../management/server.js";
import { LaunchSessionRegistry } from "../profiles/sessions.js";
import { RouteTraceRing } from "../profiles/traces.js";
import { createCodexOauthRouteResolver } from "../providers/oauth/codex/route.js";
import { managementOrigin } from "../management/origin.js";
import { SessionStore } from "../management/session-store.js";
import { AffinityStore } from "../routing/pools/affinity.js";
import { RouteSelector } from "../routing/pools/selector.js";
import { defaultControlPlaneDirectory } from "../storage/paths.js";
import { createGatewayServer, listenGateway } from "./gateway-server.js";
import { EXECUTABLE_FINGERPRINT, HEARTBEAT_MS } from "./gateway-attestation.js";
import type { AcquireGatewayOptions, GatewayLeaseHandle } from "./gateway-lifecycle.js";
import { LeaseManager } from "./lease-manager.js";
import type { ProcessIdentity } from "./ownership-record.js";
import type { RuntimeStore } from "./runtime-store.js";

const LEASE_TTL_MS = 15_000;
const IDLE_GRACE_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export type GatewayCloseTarget = Readonly<{
  close: () => Promise<unknown>;
  server: Readonly<{ closeAllConnections?: () => void }>;
}>;

/** Bounds server drain and force-closes only connections owned by this server. */
export async function closeGatewayBounded(
  target: GatewayCloseTarget,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<{ forced: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  const forced = await Promise.race([
    target.close().then(() => false, () => true),
    timedOut,
  ]);
  if (timer) clearTimeout(timer);
  if (forced) target.server.closeAllConnections?.();
  return { forced };
}

export async function startOwnedGateway(input: Readonly<{
  options: AcquireGatewayOptions;
  processIdentity: ProcessIdentity;
  store: RuntimeStore;
  baseUrl: string;
  managementBaseUrl: string;
  configFingerprint: string;
  leaseId: string;
}>): Promise<GatewayLeaseHandle> {
  const { options, processIdentity, store, baseUrl, managementBaseUrl, configFingerprint, leaseId } = input;
  const secretValue = randomBytes(32).toString("base64url");
  const managementSecretValue = randomBytes(32).toString("base64url");
  const instanceId = randomUUID();
  const sessions = new SessionStore();
  const traces = new RouteTraceRing();
  const appHolder: { app?: FastifyInstance; management?: FastifyInstance; controlPlane?: ControlPlaneStore; broker?: CredentialBroker } = {};
  const sessionHolder: { registry?: LaunchSessionRegistry } = {};
  const leases = new LeaseManager({
    ttlMs: LEASE_TTL_MS,
    idleGraceMs: IDLE_GRACE_MS,
    onExpire: (expiredLeaseId) => sessionHolder.registry?.dropLease(expiredLeaseId),
    onIdle: async (stillIdle) => {
      if (!stillIdle()) return;
      const cleanupLock = await store.acquireStartupLock(processIdentity, () => false);
      try {
        if (!stillIdle()) return;
        sessions.revokeAll();
        const managementShutdown = appHolder.management
          ? await closeGatewayBounded(appHolder.management)
          : { forced: false };
        const shutdown = appHolder.app
          ? await closeGatewayBounded(appHolder.app)
          : { forced: false };
        await appHolder.broker?.close();
        appHolder.controlPlane?.close();
        if (shutdown.forced || managementShutdown.forced || !stillIdle()) return;
        await store.removeInstanceArtifacts(instanceId);
        leases.dispose();
      } finally {
        await cleanupLock.release();
      }
    },
  });
  const launchSessions = new LaunchSessionRegistry((id) => leases.has(id));
  sessionHolder.registry = launchSessions;
  await leases.add(leaseId);
  let leaseMutation: Promise<void> = Promise.resolve();
  const serializeLeaseMutation = <T>(work: () => Promise<T>): Promise<T> => {
    const result = leaseMutation.then(work, work);
    leaseMutation = result.then(() => undefined, () => undefined);
    return result;
  };
  const registry = {
    add: (id: string): Promise<void> => serializeLeaseMutation(async () => {
      await leases.add(id);
      try {
        await store.addLease(id, processIdentity, () => false);
      } catch (error) {
        await leases.release(id);
        throw error;
      }
    }),
    renew: (id: string): Promise<void> => leases.renew(id),
    release: (id: string): Promise<void> => serializeLeaseMutation(async () => {
      launchSessions.dropLease(id);
      await store.removeLease(id, processIdentity, () => false);
      await leases.release(id);
    }),
    has: (id: string): boolean => leases.has(id),
  };
  let controlPlane: ControlPlaneStore | undefined;
  let broker: CredentialBroker | undefined;
  let app: FastifyInstance | undefined;
  let management: FastifyInstance | undefined;
  try {
    const controlPlaneDirectory = options.controlPlaneDirectory
      ?? options.config.controlPlane.dataDirectory
      ?? defaultControlPlaneDirectory();
    controlPlane = await ControlPlaneStore.open(controlPlaneDirectory);
    broker = await CredentialBroker.open(controlPlaneDirectory);
    const credentials = new CredentialService(controlPlane, broker);
    const selector = new RouteSelector(controlPlane, new AffinityStore(controlPlaneDirectory));
    appHolder.controlPlane = controlPlane;
    appHolder.broker = broker;
    const { host, port, managementPort } = options.config.gateway;
    const gatewayOptions = {
      host,
      port,
      authToken: secretValue,
      instanceId,
      configFingerprint,
      config: options.config,
      leases: registry,
      resolveOauthRoute: createCodexOauthRouteResolver(credentials, broker, configFingerprint),
      controlPlane,
      broker,
      selector,
      launchSessions,
      traces,
    };
    const managementOptions = {
      host,
      port: managementPort,
      origin: managementOrigin(host, managementPort),
      managementToken: managementSecretValue,
      instanceId,
      configFingerprint,
      store: controlPlane,
      sessions,
      credentials,
      traces,
    };
    app = (options.createServer ?? createGatewayServer)(gatewayOptions);
    management = (options.createManagementServer ?? createManagementServer)(managementOptions);
    appHolder.app = app;
    appHolder.management = management;
    await listenGateway(app, gatewayOptions);
    await listenManagement(management, managementOptions);
    await store.writeInstanceSecret(secretValue);
    await store.writeManagementSecret(managementSecretValue);
    await store.writeOwnershipRecord({
      ...processIdentity,
      instanceId,
      port: options.config.gateway.port,
      executableFingerprint: EXECUTABLE_FINGERPRINT,
      configFingerprint,
      nonceHash: createHash("sha256").update(secretValue).digest("hex"),
      ownerLauncherPid: processIdentity.pid,
      leases: [leaseId],
    });
  } catch (error) {
    leases.dispose();
    await broker?.close();
    controlPlane?.close();
    if (management) await closeGatewayBounded(management).catch(() => undefined);
    if (app) await closeGatewayBounded(app).catch(() => undefined);
    throw error;
  }
  const heartbeat = setInterval(() => {
    void leases.renew(leaseId).catch(() => undefined);
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  return {
    baseUrl,
    authToken: secretValue,
    managementBaseUrl,
    managementToken: managementSecretValue,
    instanceId,
    leaseId,
    reused: false,
    release: async () => {
      clearInterval(heartbeat);
      await registry.release(leaseId);
    },
  };
}
