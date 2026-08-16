import { OpenAiChatAdapter } from "./openai-chat-adapter.js";

/**
 * OpenRouter direct adapter (#70). Reasoning translation is owned by the
 * provider-owned boundary (`resolveReasoning`) and emitted by the shared
 * OpenAI-compatible payload path, so `enabled` and `adaptive` source modes are
 * no longer collapsed into one boolean: the translation result carries the
 * distinct kind (binary/effort/adaptive/budget/off/default) plus mapping
 * metadata. OpenRouter catalog probe uses GET /api/v1/models and never mutates
 * registry files.
 *
 * #121: OpenRouter implements the OpenAI Responses API at the SAME base path
 * (`POST https://openrouter.ai/api/v1/responses`), so same-protocol Responses
 * requests use the native Responses rail — never a lossy Chat-Completions
 * approximation. This is an exact endpoint/adapter contract claim, not a
 * generic "OpenAI-compatible" class.
 */
export class OpenRouterAdapter extends OpenAiChatAdapter {
  override readonly id = "openrouter-direct";
  protected override readonly endpoint = "https://openrouter.ai/api/v1";
  protected override readonly supportsResponsesNativeRail = true;
}
