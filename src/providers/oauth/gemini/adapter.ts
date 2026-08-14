import type { SecretHandle } from "../../../credentials/env-resolver.js";
import { OpenAiChatAdapter } from "../../direct/openai-chat-adapter.js";

export const GEMINI_OAUTH_ADAPTER_ID = "gemini-oauth";
export const GEMINI_OAUTH_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Project-owned Gemini API OAuth. Does not use Gemini CLI or Code Assist first-party clients. */
export class GeminiOAuthAdapter extends OpenAiChatAdapter {
  readonly id = GEMINI_OAUTH_ADAPTER_ID;
  protected readonly endpoint = GEMINI_OAUTH_ENDPOINT;
  protected override ownsSecret = false;

  public constructor(request: typeof fetch, private readonly accessToken: SecretHandle, endpoint?: string) {
    super(request, endpoint);
  }

  protected override resolveSecret(): SecretHandle {
    return this.accessToken;
  }
}
