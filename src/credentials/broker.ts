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
import type { CredentialProviderName } from "../providers/catalog.js";
import {
  createCodexOAuthClient,
  initialCredentialRecord,
  nextCredentialGeneration,
} from "../providers/oauth/codex/protocol.js";
import { createClaudeOAuthClient } from "../providers/oauth/claude/protocol.js";
import { createGeminiOAuthClient } from "../providers/oauth/gemini/protocol.js";
import { unsupportedOAuthClient } from "../providers/oauth/unsupported.js";
import type { OAuthClient, OAuthTokenSet } from "../providers/oauth/shared.js";
import { readCodexAuthSource, type CodexImportPreview } from "../providers/oauth/codex/source.js";
import { previewClineSource, readClineSource, rejectSilentClineDiscovery } from "../providers/interop/cline.js";

const REFRESH_SKEW_MS = 60_000;

export type RequestScopedCredential = Readonly<{
  handle: string;
  generation: number;
  accessToken: SecretHandle;
  accountId: SecretHandle | undefined;
  dispose: () => void;
}>;

export type CredentialBrokerOptions = Readonly<{
  oauth?: OAuthClient;
  oauthClients?: Partial<Record<CredentialProviderName, OAuthClient>>;
  callbackPort?: number;
  clock?: () => Date;
  environment?: NodeJS.ProcessEnv;
}>;

export class CredentialBroker {
  private readonly flights = new Map<string, Promise<CredentialMetadata>>();
  private readonly login: OauthLoginCoordinator;

  public constructor(
    readonly store: CredentialStore,
    private readonly oauth: OAuthClient,
    private readonly clock: () => Date,
    callbackPort?: number,
    private readonly oauthClients: Partial<Record<CredentialProviderName, OAuthClient>> = {},
  ) {
    this.login = new OauthLoginCoordinator(
      (provider) => this.clientFor(provider),
      (pseudonym, tokens, provider) => this.persistTokens(pseudonym, tokens, undefined, provider),
      callbackPort,
    );
  }

  public static async open(directory: string, options: CredentialBrokerOptions = {}): Promise<CredentialBroker> {
    const environment = options.environment ?? process.env;
    return new CredentialBroker(
      await CredentialStore.open(directory),
      options.oauth ?? createCodexOAuthClient(),
      options.clock ?? (() => new Date()),
      options.callbackPort,
      {
        codex: options.oauth ?? options.oauthClients?.codex ?? createCodexOAuthClient(),
        gemini: options.oauthClients?.gemini ?? createGeminiOAuthClient(fetch, environment),
        claude: options.oauthClients?.claude ?? createClaudeOAuthClient(fetch, environment),
        cline: options.oauthClients?.cline ?? unsupportedOAuthClient("cline"),
        ...options.oauthClients,
      },
    );
  }

  public async previewImport(sourcePath: string, kind: "codex" | "cline" = "codex"): Promise<CodexImportPreview | Awaited<ReturnType<typeof previewClineSource>>> {
    if (kind === "cline") {
      rejectSilentClineDiscovery(sourcePath);
      return previewClineSource(sourcePath);
    }
    return (await readCodexAuthSource(sourcePath)).preview;
  }

  public async importCodex(input: Readonly<{
    sourcePath: string;
    pseudonym: string;
    sourceFingerprint: string;
  }>): Promise<CredentialMetadata> {
    const read = await readCodexAuthSource(input.sourcePath);
    assertUnchangedFingerprint(read.preview.sourceFingerprint, input.sourceFingerprint);
    const after = await readCodexAuthSource(input.sourcePath);
    assertUnchangedFingerprint(after.preview.sourceFingerprint, read.preview.sourceFingerprint);
    return this.persistTokens(input.pseudonym, read.tokens, read.preview.sourceFingerprint, "codex");
  }

  public async importCline(input: Readonly<{
    sourcePath: string;
    pseudonym: string;
    sourceFingerprint: string;
  }>): Promise<CredentialMetadata> {
    rejectSilentClineDiscovery(input.sourcePath);
    const read = await readClineSource(input.sourcePath);
    assertUnchangedFingerprint(read.preview.sourceFingerprint, input.sourceFingerprint);
    return this.persistTokens(input.pseudonym, {
      accessToken: read.tokens.accessToken,
      refreshToken: read.tokens.refreshToken,
      expiresAt: undefined,
      accountId: undefined,
    }, read.preview.sourceFingerprint, "cline");
  }

  public startLogin(input: Readonly<{
    providerId: string;
    pseudonym: string;
    provider?: CredentialProviderName;
  }>): Promise<Readonly<{
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
    let provider: CredentialProviderName = "codex";
    try {
      const record = await this.store.read(handle);
      refreshToken = record.material.refreshToken;
      provider = record.provider;
    } catch (error) {
      if (!(error instanceof CredentialUnreadyError)) throw error;
    }
    if (refreshToken) await this.clientFor(provider).revoke(refreshToken).catch(() => undefined);
    await this.store.purge(handle);
  }

  public async metadata(handle: string): Promise<CredentialMetadata | undefined> {
    return this.store.metadata(handle);
  }

  public close(): Promise<void> {
    return this.login.close();
  }

  private clientFor(provider: CredentialProviderName): OAuthClient {
    return this.oauthClients[provider] ?? this.oauth;
  }

  private async persistTokens(
    pseudonym: string,
    tokens: OAuthTokenSet,
    sourceFingerprint?: string,
    provider: CredentialProviderName = "codex",
  ): Promise<CredentialMetadata> {
    const handle = `cred-${randomBytes(16).toString("hex")}`;
    const committed = await this.store.commit(
      handle,
      0,
      initialCredentialRecord(handle, pseudonym, tokens, sourceFingerprint, provider),
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
    const tokens = await this.clientFor(current.provider).refresh(current.material.refreshToken);
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

function assertUnchangedFingerprint(actual: string, expected: string): void {
  if (actual !== expected) throw new ImportIncompatibleError("credential source changed during import");
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
