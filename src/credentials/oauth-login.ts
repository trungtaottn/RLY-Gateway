import { OAuthFlowError } from "./errors.js";
import { OAuthSessionStore } from "./oauth-session.js";
import { matchesPkceChallenge } from "./pkce.js";
import type { CredentialMetadata } from "./record.js";
import type { CredentialProviderName } from "../providers/catalog.js";
import type { OAuthClient, OAuthTokenSet } from "../providers/oauth/shared.js";
import { listenOauthCallback, type OAuthCallbackServer } from "../providers/oauth/codex/callback-server.js";

export class OauthLoginCoordinator {
  private readonly sessions = new OAuthSessionStore();
  private callback: OAuthCallbackServer | undefined;
  private loginBusy = false;
  private loginCompletion: Promise<CredentialMetadata> | undefined;
  private loginResolve: ((value: CredentialMetadata) => void) | undefined;
  private loginReject: ((error: unknown) => void) | undefined;

  public constructor(
    private readonly oauthFor: (provider: CredentialProviderName) => OAuthClient,
    private readonly persistTokens: (pseudonym: string, tokens: OAuthTokenSet, provider: CredentialProviderName) => Promise<CredentialMetadata>,
    private readonly callbackPort?: number,
  ) {}

  public async start(input: Readonly<{
    providerId: string;
    pseudonym: string;
    provider?: CredentialProviderName;
  }>): Promise<Readonly<{
    authorizationUrl: string;
    state: string;
    redirectUri: string;
  }>> {
    if (this.callback || this.loginBusy) throw new OAuthFlowError("callback-collision", "oauth callback is already active", 409);
    const provider = input.provider;
    if (!provider) throw new OAuthFlowError("oauth-unconfigured", "oauth provider is required", 400);
    const oauth = this.oauthFor(provider);
    oauth.authorizeUrl({
      state: "preflight",
      challenge: "preflight",
      redirectUri: "http://127.0.0.1/preflight",
    });
    this.loginBusy = true;
    try {
      this.callback = await listenOauthCallback(
        async (callback) => this.handleCallback(callback),
        this.callbackPort === undefined ? {} : { port: this.callbackPort },
      );
      this.loginCompletion = new Promise((resolve, reject) => {
        this.loginResolve = resolve;
        this.loginReject = reject;
      });
      const session = this.sessions.create({
        redirectUri: this.callback.redirectUri,
        providerId: input.providerId,
        pseudonym: input.pseudonym,
        provider,
      });
      return {
        authorizationUrl: oauth.authorizeUrl({
          state: session.state,
          challenge: session.pkce.challenge,
          redirectUri: session.redirectUri,
        }),
        state: session.state,
        redirectUri: session.redirectUri,
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  public async wait(): Promise<CredentialMetadata> {
    if (!this.loginCompletion) throw new OAuthFlowError("login-inactive", "oauth login is not active");
    return this.loginCompletion;
  }

  public async cancel(state: string): Promise<void> {
    this.sessions.cancel(state);
    this.fail(new OAuthFlowError("cancelled", "oauth login was cancelled"));
    await this.close();
  }

  public async close(): Promise<void> {
    const callback = this.callback;
    this.callback = undefined;
    this.loginBusy = false;
    await callback?.close().catch(() => undefined);
  }

  private async handleCallback(callback: { code: string; state: string }): Promise<void> {
    try {
      this.succeed(await this.exchange(callback));
      this.scheduleClose();
    } catch (error) {
      if (!isStateMismatch(error)) {
        this.fail(error);
        this.scheduleClose();
      }
      throw error;
    }
  }

  private async exchange(callback: { code: string; state: string }): Promise<CredentialMetadata> {
    if (!this.callback) throw new OAuthFlowError("callback-collision", "oauth callback is not active", 409);
    const session = this.sessions.consume(callback.state, this.callback.redirectUri);
    if (!matchesPkceChallenge(session.pkce.verifier, session.pkce.challenge)) {
      throw new OAuthFlowError("pkce-mismatch", "pkce verifier does not match challenge");
    }
    return this.persistTokens(session.pseudonym, await this.oauthFor(session.provider).exchangeAuthorizationCode({
      code: callback.code,
      verifier: session.pkce.verifier,
      redirectUri: session.redirectUri,
    }), session.provider);
  }

  private succeed(metadata: CredentialMetadata): void {
    this.loginResolve?.(metadata);
    this.clearSettlers();
  }

  private fail(error: unknown): void {
    this.loginReject?.(error);
    this.clearSettlers();
  }

  private clearSettlers(): void {
    this.loginResolve = undefined;
    this.loginReject = undefined;
  }

  private scheduleClose(): void {
    setImmediate(() => {
      void this.close();
    });
  }
}

function isStateMismatch(error: unknown): boolean {
  return error instanceof OAuthFlowError && error.code === "state-mismatch";
}
