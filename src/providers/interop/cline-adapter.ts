import type { SecretHandle } from "../../credentials/env-resolver.js";
import { OpenAiChatAdapter } from "../direct/openai-chat-adapter.js";
import { ProviderAdapterError } from "../provider-adapter.js";
import { CLINE_ADAPTER_ID } from "./cline.js";

/** Request-scoped Cline tokens only. Refresh and shared-store writes stay out of this adapter. */
export class ClineInteropAdapter extends OpenAiChatAdapter {
  readonly id = CLINE_ADAPTER_ID;
  protected readonly endpoint: string;
  protected override ownsSecret = false;

  public constructor(request: typeof fetch, private readonly accessToken: SecretHandle, endpoint?: string) {
    if (!endpoint) throw new ProviderAdapterError("unavailable", "cline interoperability requires an endpoint policy");
    super(request, endpoint);
    this.endpoint = endpoint.replace(/\/$/, "");
  }

  protected override resolveSecret(): SecretHandle {
    return this.accessToken;
  }
}
