import type { GatewayConfig } from "../config/schema.js";
import { managementOrigin } from "../management/origin.js";
import { runtimeDirectory } from "../runtime/gateway-lifecycle.js";
import { RuntimeStore } from "../runtime/runtime-store.js";

export type ManagementResult = Readonly<{ ok: boolean; status: number; body: unknown }>;

/**
 * Reads the per-instance management bearer from the restrictive runtime
 * record. `undefined` means no attested RLY runtime is currently holding the
 * gateway, so the management listener cannot be reached.
 */
export async function readManagementToken(config: GatewayConfig): Promise<string | undefined> {
  const store = new RuntimeStore(runtimeDirectory(config.gateway.port));
  return store.readManagementSecret();
}

export function managementBaseUrl(config: GatewayConfig): string {
  return managementOrigin(config.gateway.host, config.gateway.managementPort);
}

/**
 * One management-API request path shared by `rly admin` and `rly config`, so
 * both surfaces observe exactly the same control-plane source of truth. DTOs
 * are secret-free by construction (`assertSecretFree` on the server).
 */
export async function managementRequest(
  baseUrl: string,
  token: string,
  origin: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<ManagementResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json().catch(() => ({ error: "invalid-response" }));
  return { ok: response.ok, status: response.status, body: payload };
}

export function printManagementResult(result: ManagementResult): void {
  console.log(JSON.stringify(result.body));
}

/**
 * Issues a single-use, short-lived UI bootstrap token and returns the loopback
 * fragment URL. The token never leaves the fragment and is never exchanged for
 * anything but the bounded `HttpOnly`/`SameSite=Strict` session cookie.
 */
export async function issueBootstrapUrl(
  baseUrl: string,
  token: string,
  origin: string,
  request: typeof managementRequest = managementRequest,
): Promise<string | undefined> {
  const issued = await request(baseUrl, token, origin, "POST", "/auth/bootstrap");
  if (!issued.ok) return undefined;
  const body = issued.body as { token?: string };
  if (typeof body.token !== "string") return undefined;
  return `${baseUrl}/#t=${body.token}`;
}

/** Parses `--key value` pairs (shared by `rly admin` and `rly config`). */
export function parseFields(args: readonly string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === undefined || !key.startsWith("--")) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} requires a value`);
    fields[key.slice(2)] = value;
    index += 1;
  }
  return fields;
}
