import { randomBytes } from "node:crypto";
import { SecretHandle } from "./env-resolver.js";
import {
  CredentialUnreadyError,
  ImportIncompatibleError,
  StaleGenerationError,
} from "./errors.js";
import { OauthLoginCoordinator } from "./oauth-login.js";
import {
  toCredentialMetadata,
  type CredentialMetadata,
  type CredentialRecord,
} from "./record.js";
import { CredentialStore } from "./store.js";
import {
  createCodexOAuthClient,
  initialCredentialRecord,
  nextCredentialGeneration,
  type CodexOAuthClient,
  type OAuthTokenSet,
} from "../providers/oauth/codex/protocol.js";
import { readCodexAuthSource, type CodexImportPreview } from "../providers/oauth/codex/source.js";

const REFRESH_SKEW_MS = 60_000;

export type RequestScopedCredential = Readonly<{
  handle: string;
  generation: number;
  accessToken: SecretHandle;
  accountId: SecretHandle | undefined;
  dispose: () => void;
}>;

export type CredentialBrokerOptions = Readonly<{
  oauth?: CodexOAuthClient;
  callbackPort?: number;
  clock?: () => Date;
}>;

export class CredentialBroker {
  private readonly flights = new Map<string, Promise<CredentialMetadata>>();
  private readonly login: OauthLoginCoordinator;

  public constructor(
    readonly store: CredentialStore,
    private readonly oauth: CodexOAuthClient,
    private readonly clock: () => Date,
    callbackPort?: number,
  ) {
    this.login = new OauthLoginCoordinator(
      oauth,
      (pseudonym, tokens) => this.persistTokens(pseudonym, tokens),
      callbackPort,
    );
  }

  public static async open(directory: string, options: CredentialBrokerOptions = {}): Promise<CredentialBroker> {
    return new CredentialBroker(
      await CredentialStore.open(directory),
      options.oauth ?? createCodexOAuthClient(),
      options.clock ?? (() => new Date()),
      options.callbackPort,
    );
  }

  public async previewImport(sourcePath: string): Promise<CodexImportPreview> {
    return (await readCodexAuthSource(sourcePath)).preview;
  }

  public async importCodex(input: Readonly<{
    sourcePath: string;
    pseudonym: string;
    sourceFingerprint: string;
  }>): Promise<CredentialMetadata> {
    const read = await readCodexAuthSource(input.sourcePath);
    if (read.preview.sourceFingerprint !== input.sourceFingerprint) {
      throw new ImportIncompatibleError("credential source changed during import");
    }
    const after = await readCodexAuthSource(input.sourcePath);
    if (after.preview.sourceFingerprint !== read.preview.sourceFingerprint) {
      throw new ImportIncompatibleError("credential source changed during import");
    }
    return this.persistTokens(input.pseudonym, read.tokens, read.preview.sourceFingerprint);
  }

  public startLogin(input: Readonly<{ providerId: string; pseudonym: string }>): Promise<Readonly<{
    authorizationUrl: string;
    state: string;
    redirectUri: string;
  }>> {
    return this.login.start(input);
  }

  public waitForLogin(): Promise<CredentialMetadata> {
    return this.login.wait();
  }

  public cancelLogin(state: string): Promise<void> {
    return this.login.cancel(state);
  }

  public async resolve(handle: string): Promise<RequestScopedCredential> {
    return scopedFromRecord(await this.ensureFresh(handle));
  }

  public async refresh(handle: string): Promise<CredentialMetadata> {
    const existing = this.flights.get(handle);
    if (existing) return existing;
    const flight = this.refreshOnce(handle).finally(() => this.flights.delete(handle));
    this.flights.set(handle, flight);
    return flight;
  }

  public async revoke(handle: string): Promise<void> {
    let refreshToken: string | undefined;
    try {
      refreshToken = (await this.store.read(handle)).material.refreshToken;
    } catch (error) {
      if (!(error instanceof CredentialUnreadyError)) throw error;
    }
    if (refreshToken) await this.oauth.revoke(refreshToken).catch(() => undefined);
    await this.store.purge(handle);
  }

  public async metadata(handle: string): Promise<CredentialMetadata | undefined> {
    return this.store.metadata(handle);
  }

  public close(): Promise<void> {
    return this.login.close();
  }

  private async persistTokens(
    pseudonym: string,
    tokens: OAuthTokenSet,
    sourceFingerprint?: string,
  ): Promise<CredentialMetadata> {
    const handle = `cred-${randomBytes(16).toString("hex")}`;
    const committed = await this.store.commit(
      handle,
      0,
      initialCredentialRecord(handle, pseudonym, tokens, sourceFingerprint),
    );
    return toCredentialMetadata(committed);
  }

  private async ensureFresh(handle: string): Promise<CredentialRecord> {
    const record = await this.store.read(handle);
    if (!needsRefresh(record.expiresAt, this.clock())) return record;
    const refreshed = await this.refresh(handle);
    if (refreshed.generation === record.generation) throw new StaleGenerationError();
    return this.store.read(handle);
  }

  private async refreshOnce(handle: string): Promise<CredentialMetadata> {
    const current = await this.store.read(handle);
    const tokens = await this.oauth.refresh(current.material.refreshToken);
    try {
      const committed = await this.store.commit(handle, current.generation, nextCredentialGeneration(current, tokens));
      return toCredentialMetadata(committed);
    } catch (error) {
      if (error instanceof StaleGenerationError) {
        const latest = await this.store.metadata(handle);
        if (latest) return latest;
      }
      throw error;
    }
  }
}

function needsRefresh(expiresAt: string | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - now.getTime() <= REFRESH_SKEW_MS;
}

function scopedFromRecord(record: CredentialRecord): RequestScopedCredential {
  const accessToken = new SecretHandle(record.material.accessToken);
  const accountId = record.material.accountId === undefined ? undefined : new SecretHandle(record.material.accountId);
  return {
    handle: record.handle,
    generation: record.generation,
    accessToken,
    accountId,
    dispose: () => {
      accessToken.dispose();
      accountId?.dispose();
    },
  };
}
