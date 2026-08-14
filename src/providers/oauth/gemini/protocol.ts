import {
  authorizationCodeUrl,
  requestOAuthToken,
  requiredOAuthClientId,
  revokeOAuthToken,
  type OAuthClient,
} from "../shared.js";

export const GEMINI_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GEMINI_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GEMINI_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GEMINI_OAUTH_SCOPE = "https://www.googleapis.com/auth/generative-language";
export const GEMINI_CLIENT_ID_ENV = "RLY_GEMINI_OAUTH_CLIENT_ID";

export function geminiClientId(environment: NodeJS.ProcessEnv = process.env): string {
  return requiredOAuthClientId(environment, GEMINI_CLIENT_ID_ENV, "gemini");
}

export function createGeminiOAuthClient(
  request: typeof fetch = fetch,
  environment: NodeJS.ProcessEnv = process.env,
): OAuthClient {
  const clientId = () => geminiClientId(environment);
  return {
    authorizeUrl(input) {
      return authorizationCodeUrl(GEMINI_OAUTH_AUTHORIZE_URL, {
        response_type: "code",
        client_id: clientId(),
        redirect_uri: input.redirectUri,
        scope: GEMINI_OAUTH_SCOPE,
        state: input.state,
        code_challenge: input.challenge,
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent",
      });
    },
    exchangeAuthorizationCode(input) {
      return requestOAuthToken(request, GEMINI_OAUTH_TOKEN_URL, {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: clientId(),
        code_verifier: input.verifier,
      });
    },
    refresh(refreshToken) {
      return requestOAuthToken(request, GEMINI_OAUTH_TOKEN_URL, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId(),
      }, refreshToken);
    },
    revoke(refreshToken) {
      return revokeOAuthToken(request, GEMINI_OAUTH_REVOKE_URL, { token: refreshToken });
    },
  };
}
