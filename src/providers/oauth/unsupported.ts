import { OAuthFlowError } from "../../credentials/errors.js";
import type { OAuthClient } from "./shared.js";

export function unsupportedOAuthClient(provider: string): OAuthClient {
  const fail = (): never => {
    throw new OAuthFlowError("unsupported", `${provider} does not use project-owned oauth refresh`, 400);
  };
  return {
    authorizeUrl: fail,
    exchangeAuthorizationCode: fail,
    refresh: fail,
    revoke: () => Promise.resolve(),
  };
}
