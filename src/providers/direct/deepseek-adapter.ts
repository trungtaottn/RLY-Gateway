import { OpenAiChatAdapter } from "./openai-chat-adapter.js";

/** DeepSeek requires prior assistant reasoning_content to accompany tool-call replay. */
export class DeepSeekAdapter extends OpenAiChatAdapter {
  readonly id = "deepseek-direct";
  protected readonly endpoint = "https://api.deepseek.com";
  protected override readonly replayReasoningContent = true;
}
