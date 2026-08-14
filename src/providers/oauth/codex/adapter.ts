import type { SecretHandle } from "../../../credentials/env-resolver.js";
import { OpenAiChatAdapter } from "../../direct/openai-chat-adapter.js";

export const CODEX_OAUTH_ADAPTER_ID = "codex-oauth";
export const CODEX_OAUTH_ENDPOINT = "https://chatgpt.com/backend-api/codex";

/** Translates canonical requests only. Persistence stays in the credential broker. */
export class CodexOAuthAdapter extends OpenAiChatAdapter {
  readonly id = CODEX_OAUTH_ADAPTER_ID;
  protected readonly endpoint = CODEX_OAUTH_ENDPOINT;
  protected override ownsSecret = false;

  public constructor(
    request: typeof fetch,
    private readonly accessToken: SecretHandle,
    endpoint?: string,
    private readonly accountId?: SecretHandle,
  ) {
    super(request, endpoint);
  }

  protected override resolveSecret(): SecretHandle {
    return this.accessToken;
  }

  protected override extraHeaders(): Readonly<Record<string, string>> {
    if (!this.accountId) return { originator: "agent-gateway" };
    return { originator: "agent-gateway", "chatgpt-account-id": this.accountId.reveal() };
  }
}
