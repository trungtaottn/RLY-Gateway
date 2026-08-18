import { OAuthFlowError } from "../../credentials/errors.js";

export type OAuthTokenSet = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: string | undefined;
  accountId: string | undefined;
}>;

export type OAuthClient = Readonly<{
  authorizeUrl(input: Readonly<{ state: string; challenge: string; redirectUri: string }>): string;
  exchangeAuthorizationCode(input: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
  }>): Promise<OAuthTokenSet>;
  refresh(refreshToken: string): Promise<OAuthTokenSet>;
  revoke(refreshToken: string): Promise<void>;
}>;

const MAX_OAUTH_BODY_BYTES = 4096;

export function requiredOAuthClientId(
  environment: NodeJS.ProcessEnv,
  envName: string,
  provider: string,
): string {
  const value = environment[envName];
  if (!value) throw new OAuthFlowError("oauth-unconfigured", `${provider} oauth client id is not configured`, 400);
  return value;
}

export function authorizationCodeUrl(
  authorizeUrl: string,
  params: Readonly<Record<string, string>>,
): string {
  const url = new URL(authorizeUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export async function requestOAuthToken(
  request: typeof fetch,
  tokenUrl: string,
  fields: Readonly<Record<string, string>>,
  previousRefreshToken?: string,
): Promise<OAuthTokenSet> {
  const response = await request(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });
  const raw = await response.text();
  if (raw.length > MAX_OAUTH_BODY_BYTES) throw new OAuthFlowError("oversized-oauth", "oauth response exceeded bound");
  if (!response.ok) {
    throw new OAuthFlowError(response.status === 400 ? "invalid-grant" : "oauth-failed", "oauth token request failed", response.status === 400 ? 400 : 502);
  }
  const body = JSON.parse(raw) as Record<string, unknown>;
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : previousRefreshToken;
  if (!accessToken || !refreshToken) throw new OAuthFlowError("malformed-token", "oauth token response is malformed");
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    accountId: undefined,
  };
}

export async function revokeOAuthToken(
  request: typeof fetch,
  revokeUrl: string,
  fields: Readonly<Record<string, string>>,
): Promise<void> {
  const response = await request(revokeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  if (!response.ok && response.status !== 400) {
    throw new OAuthFlowError("revoke-failed", "upstream revoke failed", 502);
  }
}
