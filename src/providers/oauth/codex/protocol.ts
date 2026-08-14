import { createHash } from "node:crypto";
import { OAuthFlowError } from "../../../credentials/errors.js";
import {
  CREDENTIAL_PROVIDER_CODEX,
  CREDENTIAL_SCHEMA_VERSION,
  type CredentialRecord,
} from "../../../credentials/record.js";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_REVOKE_URL = "https://auth.openai.com/oauth/revoke";
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access";
export const CODEX_OAUTH_REDIRECT_URI = "http://127.0.0.1:17873/callback";
export const CODEX_OAUTH_CALLBACK_PORT = 17873;
const MAX_OAUTH_BODY_BYTES = 4096;

export type OAuthTokenSet = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: string | undefined;
  accountId: string | undefined;
}>;

export type CodexOAuthClient = Readonly<{
  authorizeUrl(input: Readonly<{ state: string; challenge: string; redirectUri: string }>): string;
  exchangeAuthorizationCode(input: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
  }>): Promise<OAuthTokenSet>;
  refresh(refreshToken: string): Promise<OAuthTokenSet>;
  revoke(refreshToken: string): Promise<void>;
}>;

export function createCodexOAuthClient(
  request: typeof fetch = fetch,
  endpoints: Readonly<{ token?: string; revoke?: string }> = {},
): CodexOAuthClient {
  const tokenUrl = endpoints.token ?? CODEX_OAUTH_TOKEN_URL;
  const revokeUrl = endpoints.revoke ?? CODEX_OAUTH_REVOKE_URL;
  return {
    authorizeUrl(input) {
      const url = new URL(CODEX_OAUTH_AUTHORIZE_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("scope", CODEX_OAUTH_SCOPE);
      url.searchParams.set("state", input.state);
      url.searchParams.set("code_challenge", input.challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    exchangeAuthorizationCode(input) {
      return tokenRequest(request, tokenUrl, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: CODEX_OAUTH_CLIENT_ID,
        code_verifier: input.verifier,
      });
    },
    refresh(refreshToken) {
      return tokenRequest(request, tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }, refreshToken);
    },
    async revoke(refreshToken) {
      const response = await request(revokeUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ token: refreshToken, client_id: CODEX_OAUTH_CLIENT_ID }).toString(),
      });
      await readBoundedBody(response);
      if (!response.ok && response.status !== 400) {
        throw new OAuthFlowError("revoke-failed", "upstream revoke failed", 502);
      }
    },
  };
}

export function fingerprintRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

export function expiresAtFromSeconds(now: Date, expiresIn: number | undefined): string | undefined {
  if (expiresIn === undefined || !Number.isFinite(expiresIn) || expiresIn <= 0) return undefined;
  return new Date(now.getTime() + expiresIn * 1000).toISOString();
}

export function initialCredentialRecord(
  handle: string,
  pseudonym: string,
  tokens: OAuthTokenSet,
  sourceFingerprint?: string,
): CredentialRecord {
  return {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    provider: CREDENTIAL_PROVIDER_CODEX,
    handle,
    pseudonym,
    generation: 1,
    expiresAt: tokens.expiresAt,
    refreshFingerprint: fingerprintRefreshToken(tokens.refreshToken),
    ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
    material: tokenMaterial(tokens),
  };
}

export function nextCredentialGeneration(
  current: CredentialRecord,
  tokens: OAuthTokenSet,
): CredentialRecord {
  return {
    ...current,
    generation: current.generation + 1,
    expiresAt: tokens.expiresAt,
    refreshFingerprint: fingerprintRefreshToken(tokens.refreshToken),
    material: tokenMaterial(tokens),
  };
}

function tokenMaterial(tokens: OAuthTokenSet): CredentialRecord["material"] {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    ...(tokens.accountId === undefined ? {} : { accountId: tokens.accountId }),
  };
}

async function tokenRequest(
  request: typeof fetch,
  url: string,
  fields: Readonly<Record<string, string>>,
  previousRefreshToken?: string,
): Promise<OAuthTokenSet> {
  const response = await request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
  const raw = await readBoundedBody(response);
  if (!response.ok) {
    throw new OAuthFlowError(
      response.status === 400 ? "invalid-grant" : "oauth-failed",
      "oauth token request failed",
      response.status === 400 ? 400 : 502,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new OAuthFlowError("malformed-token", "oauth token response is malformed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OAuthFlowError("malformed-token", "oauth token response is malformed");
  }
  const body = parsed as Record<string, unknown>;
  const accessToken = requiredString(body["access_token"], "malformed-token");
  const refreshToken = optionalString(body["refresh_token"]) ?? previousRefreshToken;
  if (!refreshToken) throw new OAuthFlowError("malformed-token", "oauth token response is malformed");
  const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : undefined;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAtFromSeconds(new Date(), expiresIn),
    accountId: optionalString(body["account_id"]),
  };
}

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value instanceof Uint8Array ? chunk.value : undefined;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_OAUTH_BODY_BYTES) throw new OAuthFlowError("oversized-oauth", "oauth response exceeded bound");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new OAuthFlowError(code, "oauth token response is malformed");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
