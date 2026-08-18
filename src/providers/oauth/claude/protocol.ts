import {
  authorizationCodeUrl,
  requestOAuthToken,
  requiredOAuthClientId,
  revokeOAuthToken,
  type OAuthClient,
} from "../shared.js";

export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.com/oauth/authorize";
export const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const CLAUDE_OAUTH_REVOKE_URL = "https://console.anthropic.com/v1/oauth/revoke";
export const CLAUDE_OAUTH_SCOPE = "user:inference";
export const CLAUDE_CLIENT_ID_ENV = "RLY_CLAUDE_OAUTH_CLIENT_ID";

export function claudeClientId(environment: NodeJS.ProcessEnv = process.env): string {
  return requiredOAuthClientId(environment, CLAUDE_CLIENT_ID_ENV, "claude");
}

export function createClaudeOAuthClient(
  request: typeof fetch = fetch,
  environment: NodeJS.ProcessEnv = process.env,
): OAuthClient {
  const clientId = () => claudeClientId(environment);
  return {
    authorizeUrl(input) {
      return authorizationCodeUrl(CLAUDE_OAUTH_AUTHORIZE_URL, {
        response_type: "code",
        client_id: clientId(),
        redirect_uri: input.redirectUri,
        scope: CLAUDE_OAUTH_SCOPE,
        state: input.state,
        code_challenge: input.challenge,
        code_challenge_method: "S256",
      });
    },
    exchangeAuthorizationCode(input) {
      return requestOAuthToken(request, CLAUDE_OAUTH_TOKEN_URL, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: clientId(),
        code_verifier: input.verifier,
      });
    },
    refresh(refreshToken) {
      return requestOAuthToken(request, CLAUDE_OAUTH_TOKEN_URL, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId(),
      }, refreshToken);
    },
    revoke(refreshToken) {
      return revokeOAuthToken(request, CLAUDE_OAUTH_REVOKE_URL, { token: refreshToken, client_id: clientId() });
    },
  };
}
