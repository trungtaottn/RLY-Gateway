import { OpenAiChatAdapter } from "./openai-chat-adapter.js";
import type { CanonicalRequest } from "../../core/canonical-request.js";

/** OpenRouter catalog probe uses GET /api/v1/models and never mutates registry files. */
export class OpenRouterAdapter extends OpenAiChatAdapter {
  readonly id = "openrouter-direct";
  protected readonly endpoint = "https://openrouter.ai/api/v1";

  protected override payload(request: CanonicalRequest): Record<string, unknown> {
    return {
      ...super.payload(request),
      ...(request.inference.thinking === "enabled" || request.inference.thinking === "adaptive" ? { reasoning: { enabled: true } } : {}),
    };
  }
}
