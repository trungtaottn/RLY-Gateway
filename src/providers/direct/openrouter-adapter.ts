import { OpenAiChatAdapter } from "./openai-chat-adapter.js";

/**
 * OpenRouter direct adapter (#70). Reasoning translation is owned by the
 * provider-owned boundary (`resolveReasoning`) and emitted by the shared
 * OpenAI-compatible payload path, so `enabled` and `adaptive` source modes are
 * no longer collapsed into one boolean: the translation result carries the
 * distinct kind (binary/effort/adaptive/budget/off/default) plus mapping
 * metadata. OpenRouter catalog probe uses GET /api/v1/models and never mutates
 * registry files.
 */
export class OpenRouterAdapter extends OpenAiChatAdapter {
  readonly id = "openrouter-direct";
  protected readonly endpoint = "https://openrouter.ai/api/v1";
}
