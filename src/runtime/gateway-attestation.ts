import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createIdentityProof } from "./gateway-server.js" ;
import { createManagementIdentityProof } from "../management/server.js" ;
import type { OwnershipRecord } from "./ownership-record.js" ;
import type { BuildIdentity } from "./build-identity.js" ;
import { buildIdentityDigest } from "./build-identity.js" ;

export const HEARTBEAT_MS = 5_000;
export const RUNTIME_VERSION = "0.1.0";
export const EXECUTABLE_FINGERPRINT = createHash("sha256").update("rly-gateway:0.1.0").digest("hex");

export type GatewayIdentity = Readonly<{
  product: string;
  instanceId: string;
  configFingerprint: string;
  protocolVersion: number;
  /** Advisory runtime binary version used for the #73 update/restart handshake. */
  runtimeVersion?: string;
  /** True when this instance is owned by the per-user resident service. */
  resident?: boolean;
  /** Durable state/schema version the serving runtime was built against (#73). */
  stateVersion?: number;
  /** Active launch-session count (#73 drain semantics; not TCP connection count). */
  activeSessions?: number;
  /** True once the #73 update drain phase has begun on this process. */
  draining?: boolean;
  /** Secret-free update metadata (#73). */
  update?: Readonly<{ state: string; pendingVersion?: string; previousVersion?: string }>;
  /**
   * Exact build identity (#94): semantic version, commit revision, build ID,
   * release channel, control/data protocol versions, state schema version,
   * and the serving artifact digest when running from a #92 deployment. Same
   * semantic version, different artifact is observable and comparable here.
   */
  build?: BuildIdentity;
  proof: string;
}>;

export async function attestedIdentities(
  request: typeof fetch,
  baseUrl: string,
  managementBaseUrl: string,
  secret: string,
  managementSecret: string,
): Promise<{ identity: GatewayIdentity; managementIdentity: GatewayIdentity | undefined } | undefined> {
  const identity = await identityChallenge(request, baseUrl, secret);
  if (!identity) return undefined;
  return {
    identity,
    managementIdentity: await identityChallenge(
      request,
      managementBaseUrl,
      managementSecret,
      "rly-gateway-management",
      createManagementIdentityProof,
    ),
  };
}

export async function listenerExists(request: typeof fetch, baseUrl: string): Promise<boolean> {
  try {
    await request(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

export async function mutateRemoteLease(
  request: typeof fetch,
  method: "POST" | "PUT" | "DELETE",
  baseUrl: string,
  leaseId: string,
  secret: string,
): Promise<void> {
  const response = await request(`${baseUrl}/leases/${leaseId}`, {
    method,
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(750),
  });
  if (!response.ok) throw new Error(`Gateway lease ${method.toLowerCase()} failed`);
}

/**
 * Build-aware reuse gate (#94). A pre-#94 ownership record (old executable
 * fingerprint) is reusable only by a legacy identity without a `build`
 * field. A #94 record carries `executableFingerprint = buildIdentityDigest`
 * of the serving build identity (including the artifact digest), so an
 * attested instance started from one artifact can never be reused as a
 * different artifact — even when the semantic versions match.
 */
export function buildMatchesRecord(record: OwnershipRecord, identity: GatewayIdentity): boolean {
  if (record.executableFingerprint === EXECUTABLE_FINGERPRINT) {
    // Legacy record: reuse only the legacy gate (identity carries no build).
    return identity.build === undefined;
  }
  return identity.build !== undefined && buildIdentityDigest(identity.build) === record.executableFingerprint;
}

export function reusableRecord(
  record: OwnershipRecord,
  identity: GatewayIdentity,
  configFingerprint: string,
): boolean {
  return record.instanceId === identity.instanceId
    && record.configFingerprint === configFingerprint
    && identity.configFingerprint === configFingerprint
    && buildMatchesRecord(record, identity);
}

export function heartbeatRemote(
  request: typeof fetch,
  baseUrl: string,
  leaseId: string,
  secret: string,
  intervalMs = HEARTBEAT_MS,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void mutateRemoteLease(request, "PUT", baseUrl, leaseId, secret).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return timer;
}

async function identityChallenge(
  request: typeof fetch,
  baseUrl: string,
  secret: string,
  expectedProduct = "rly-gateway",
  proof: typeof createIdentityProof = createIdentityProof,
): Promise<GatewayIdentity | undefined> {
  const challenge = randomBytes(32).toString("base64url");
  try {
    const response = await request(`${baseUrl}/identity?challenge=${challenge}`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return undefined;
    const identity = await response.json() as GatewayIdentity;
    const expected = proof(
      secret,
      challenge,
      identity.instanceId,
      identity.configFingerprint,
    );
    return identity.product === expectedProduct
      && identity.protocolVersion === 1
      && safeEqual(identity.proof, expected)
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
