import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OAuthTokenSet } from "../../src/providers/oauth/codex/protocol.js";
import type { CodexOAuthClient } from "../../src/providers/oauth/codex/protocol.js";

export const FIXTURE_ACCESS = "access-token-fixture-not-secret";
export const FIXTURE_REFRESH = "refresh-token-fixture-not-secret";
export const FIXTURE_ACCESS_NEXT = "access-token-fixture-next-not-secret";
export const FIXTURE_REFRESH_NEXT = "refresh-token-fixture-next-not-secret";

export async function tempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeCodexSource(directory: string, tokens: Readonly<{ access?: string; refresh?: string }> = {}): Promise<{ path: string; sourceFingerprint: string }> {
  const path = join(directory, "auth.json");
  const contents = JSON.stringify({
    tokens: {
      access_token: tokens.access ?? FIXTURE_ACCESS,
      refresh_token: tokens.refresh ?? FIXTURE_REFRESH,
    },
  });
  await writeFile(path, contents, "utf8");
  return { path, sourceFingerprint: fingerprint(contents) };
}

export async function writeClineSource(directory: string, tokens: Readonly<{ access?: string; refresh?: string; fileName?: string }> = {}): Promise<{ path: string; sourceFingerprint: string; contents: string }> {
  const path = join(directory, tokens.fileName ?? "cline-auth.json");
  const contents = JSON.stringify({
    tokens: {
      access_token: tokens.access ?? FIXTURE_ACCESS,
      refresh_token: tokens.refresh ?? FIXTURE_REFRESH,
    },
  });
  await writeFile(path, contents, "utf8");
  return { path, sourceFingerprint: fingerprint(contents), contents };
}

export function fixtureTokens(overrides: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    accessToken: FIXTURE_ACCESS,
    refreshToken: FIXTURE_REFRESH,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    accountId: undefined,
    ...overrides,
  };
}

export function fakeOauth(hooks: {
  refresh?: () => Promise<OAuthTokenSet>;
  exchange?: () => Promise<OAuthTokenSet>;
  revoke?: () => Promise<void>;
} = {}): CodexOAuthClient & { refreshCalls: number } {
  const client = {
    refreshCalls: 0,
    authorizeUrl(input: Readonly<{ state: string; challenge: string; redirectUri: string }>): string {
      return `http://127.0.0.1/authorize?state=${input.state}&code_challenge=${input.challenge}&redirect_uri=${encodeURIComponent(input.redirectUri)}&code_challenge_method=S256`;
    },
    exchangeAuthorizationCode: async (): Promise<OAuthTokenSet> => hooks.exchange ? hooks.exchange() : fixtureTokens(),
    refresh: async (): Promise<OAuthTokenSet> => {
      client.refreshCalls += 1;
      return hooks.refresh ? hooks.refresh() : fixtureTokens({ accessToken: FIXTURE_ACCESS_NEXT, refreshToken: FIXTURE_REFRESH_NEXT });
    },
    revoke: async (): Promise<void> => {
      await hooks.revoke?.();
    },
  };
  return client;
}
