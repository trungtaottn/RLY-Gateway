import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../config/schema.js";
import { fingerprintConfig } from "../config/config-fingerprint.js";
import type { createManagementServer } from "../management/server.js";
import type { BuildIdentity } from "./build-identity.js";
import {
  attestedIdentities,
  heartbeatRemote,
  listenerExists,
  mutateRemoteLease,
  reusableRecord,
} from "./gateway-attestation.js";
import type { createGatewayServer } from "./gateway-server.js";
import { startOwnedGateway } from "./owned-gateway.js";
import type { OwnershipRecord, ProcessIdentity } from "./ownership-record.js";
import { readProcessIdentity } from "./process-identity.js";
import { RuntimeStore, StartupLockUnavailableError } from "./runtime-store.js";

export type { GatewayCloseTarget } from "./owned-gateway.js";
export { closeGatewayBounded } from "./owned-gateway.js";

export type GatewayLeaseHandle = Readonly<{
  baseUrl: string;
  authToken: string;
  managementBaseUrl: string;
  managementToken: string;
  instanceId: string;
  leaseId: string;
  reused: boolean;
  /** Present when this instance is owned by the per-user resident service. */
  resident?: boolean;
  runtimeVersion?: string;
  /** Explicit in-process shutdown for the resident service stop path. */
  shutdown?: () => Promise<void>;
  /** Resolves once the resident runtime has fully shut down. */
  stopped?: Promise<void>;
  release: () => Promise<void>;
}>;

export type AcquireGatewayOptions = Readonly<{
  config: GatewayConfig;
  runtimeDirectory?: string;
  controlPlaneDirectory?: string;
  processIdentity?: ProcessIdentity;
  store?: RuntimeStore;
  fetch?: typeof fetch;
  createServer?: typeof createGatewayServer;
  createManagementServer?: typeof createManagementServer;
  heartbeatMs?: number;
  /** Starts the runtime with explicit per-user service ownership. */
  resident?: boolean;
  /**
   * Exact build identity (#94). Defaults to the compiled identity plus the
   * `RLY_SERVING_ARTIFACT` env exported by the stable bootstrap; tests and
   * distributions override it to prove identity surfaces agree.
   */
  buildIdentity?: BuildIdentity;
  environment?: NodeJS.ProcessEnv;
}>;

export function runtimeDirectory(port: number): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Gateway lifecycle requires a POSIX uid");
  return join(tmpdir(), `rly-gateway-${String(uid)}-${String(port)}`);
}

/** Starts or safely reuses the one deterministic, attested loopback gateway. */
async function acquireGatewayOnce(options: AcquireGatewayOptions): Promise<GatewayLeaseHandle> {
  const request = options.fetch ?? fetch;
  const processIdentity = options.processIdentity ?? await currentProcessIdentity();
  const store = options.store ?? new RuntimeStore(
    options.runtimeDirectory ?? runtimeDirectory(options.config.gateway.port),
    { processIdentityLookup: readProcessIdentity },
  );
  const lock = await store.acquireStartupLock(processIdentity, async (candidate) => {
    if (!candidate) return true;
    const observed = await readProcessIdentity(candidate.owner.pid);
    return observed?.processStartedAt !== candidate.owner.processStartedAt;
  });
  const baseUrl = `http://${options.config.gateway.host}:${String(options.config.gateway.port)}`;
  const managementBaseUrl = `http://${options.config.gateway.host}:${String(options.config.gateway.managementPort)}`;
  const configFingerprint = fingerprintConfig(options.config);
  const leaseId = randomUUID();
  try {
    const record = await store.readOwnershipRecord();
    const secret = await store.readInstanceSecret();
    const managementSecret = await store.readManagementSecret();
    if (record && secret && managementSecret) {
      const reused = await tryReuseAttestedGateway({
        request,
        baseUrl,
        managementBaseUrl,
        secret,
        managementSecret,
        record,
        configFingerprint,
        leaseId,
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      });
      if (reused) return reused;
    }
    if (await listenerExists(request, baseUrl)) {
      throw new Error("Configured gateway port is occupied by a foreign or unattested listener");
    }
    if (await listenerExists(request, managementBaseUrl)) {
      throw new Error("Configured management port is occupied by a foreign or unattested listener");
    }
    if (record) await store.removeInstanceArtifacts(record.instanceId);
    return await startOwnedGateway({
      options,
      processIdentity,
      store,
      baseUrl,
      managementBaseUrl,
      configFingerprint,
      leaseId,
    });
  } finally {
    await lock.release();
  }
}

/** Waits briefly for a concurrent launcher holding the atomic startup lock. */
export async function acquireGateway(options: AcquireGatewayOptions): Promise<GatewayLeaseHandle> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await acquireGatewayOnce(options);
    } catch (error: unknown) {
      if (!(error instanceof StartupLockUnavailableError)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

export type RuntimeInspection =
  | Readonly<{ state: "not-running" }>
  | Readonly<{ state: "attested-compatible"; resident: boolean; runtimeVersion?: string; instanceId: string; buildIdentity?: BuildIdentity }>
  | Readonly<{ state: "attested-incompatible" }>
  | Readonly<{ state: "occupied-foreign" }>
  | Readonly<{ state: "stale-record" }>;

export async function inspectRuntimeGateway(
  config: GatewayConfig,
  directory?: string,
  request: typeof fetch = fetch,
): Promise<RuntimeInspection> {
  const store = new RuntimeStore(directory ?? runtimeDirectory(config.gateway.port));
  const baseUrl = `http://${config.gateway.host}:${String(config.gateway.port)}`;
  const managementBaseUrl = `http://${config.gateway.host}:${String(config.gateway.managementPort)}`;
  const record = await store.readOwnershipRecord();
  const secret = await store.readInstanceSecret();
  const managementSecret = await store.readManagementSecret();
  if (record && secret && managementSecret) {
    const attested = await attestedIdentities(request, baseUrl, managementBaseUrl, secret, managementSecret);
    if (attested) {
      const observed = await readProcessIdentity(record.pid);
      const compatible = attested.managementIdentity !== undefined
        && reusableRecord(record, attested.identity, fingerprintConfig(config))
        && attested.managementIdentity.instanceId === attested.identity.instanceId
        && observed?.processStartedAt === record.processStartedAt;
      return compatible
        ? {
            state: "attested-compatible",
            resident: attested.identity.resident === true,
            ...(attested.identity.runtimeVersion === undefined ? {} : { runtimeVersion: attested.identity.runtimeVersion }),
            ...(attested.identity.build === undefined ? {} : { buildIdentity: attested.identity.build }),
            instanceId: record.instanceId,
          }
        : { state: "attested-incompatible" };
    }
  }
  if (await listenerExists(request, baseUrl) || await listenerExists(request, managementBaseUrl)) {
    return { state: "occupied-foreign" };
  }
  return record ? { state: "stale-record" } : { state: "not-running" };
}

export async function inspectGateway(
  config: GatewayConfig,
  directory?: string,
  request: typeof fetch = fetch,
): Promise<"not-running" | "attested-compatible" | "attested-incompatible" | "occupied-foreign" | "stale-record"> {
  return (await inspectRuntimeGateway(config, directory, request)).state;
}

async function tryReuseAttestedGateway(input: Readonly<{
  request: typeof fetch;
  baseUrl: string;
  managementBaseUrl: string;
  secret: string;
  managementSecret: string;
  record: OwnershipRecord;
  configFingerprint: string;
  leaseId: string;
  heartbeatMs?: number;
}>): Promise<GatewayLeaseHandle | undefined> {
  const attested = await attestedIdentities(
    input.request,
    input.baseUrl,
    input.managementBaseUrl,
    input.secret,
    input.managementSecret,
  );
  if (!attested) return undefined;
  const { identity, managementIdentity } = attested;
  if (!managementIdentity) {
    throw new Error("Configured management port is occupied by a foreign or unattested listener");
  }
  if (!reusableRecord(input.record, identity, input.configFingerprint)
    || managementIdentity.instanceId !== identity.instanceId
    || managementIdentity.configFingerprint !== input.configFingerprint) {
    throw new Error("Configured gateway listener is attested but incompatible");
  }
  const observed = await readProcessIdentity(input.record.pid);
  if (observed?.processStartedAt !== input.record.processStartedAt) {
    throw new Error("Gateway ownership record has stale process identity");
  }
  await mutateRemoteLease(input.request, "POST", input.baseUrl, input.leaseId, input.secret);
  const heartbeat = heartbeatRemote(
    input.request,
    input.baseUrl,
    input.leaseId,
    input.secret,
    input.heartbeatMs,
  );
  return {
    baseUrl: input.baseUrl,
    authToken: input.secret,
    managementBaseUrl: input.managementBaseUrl,
    managementToken: input.managementSecret,
    instanceId: input.record.instanceId,
    leaseId: input.leaseId,
    reused: true,
    ...(identity.runtimeVersion === undefined ? {} : { runtimeVersion: identity.runtimeVersion }),
    release: async () => {
      clearInterval(heartbeat);
      await mutateRemoteLease(input.request, "DELETE", input.baseUrl, input.leaseId, input.secret).catch(() => undefined);
    },
  };
}

async function currentProcessIdentity(): Promise<ProcessIdentity> {
  const identity = await readProcessIdentity(process.pid);
  if (!identity) throw new Error("Unable to read gateway process start identity");
  return identity;
}
