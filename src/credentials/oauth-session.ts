import { randomBytes } from "node:crypto";
import { OAuthFlowError } from "./errors.js";
import { createPkcePair, type PkcePair } from "./pkce.js";

const STATE_TTL_MS = 10 * 60 * 1000;

export type OAuthSession = Readonly<{
  state: string;
  pkce: PkcePair;
  redirectUri: string;
  provider: "codex";
  providerId: string;
  pseudonym: string;
  expiresAt: number;
}>;

export class OAuthSessionStore {
  private readonly sessions = new Map<string, OAuthSession>();

  public constructor(private readonly now: () => number = () => Date.now()) {}

  public create(input: Readonly<{
    redirectUri: string;
    providerId: string;
    pseudonym: string;
  }>): OAuthSession {
    const session: OAuthSession = {
      state: randomBytes(32).toString("base64url"),
      pkce: createPkcePair(),
      redirectUri: input.redirectUri,
      provider: "codex",
      providerId: input.providerId,
      pseudonym: input.pseudonym,
      expiresAt: this.now() + STATE_TTL_MS,
    };
    this.sessions.set(session.state, session);
    return session;
  }

  public consume(state: string, redirectUri: string): OAuthSession {
    const session = this.sessions.get(state);
    this.sessions.delete(state);
    if (!session) throw new OAuthFlowError("state-mismatch", "oauth state is invalid or already used");
    if (session.expiresAt <= this.now()) throw new OAuthFlowError("state-expired", "oauth state expired");
    if (session.redirectUri !== redirectUri) throw new OAuthFlowError("redirect-mismatch", "oauth redirect does not match");
    return session;
  }

  public cancel(state: string): void {
    this.sessions.delete(state);
  }
}
