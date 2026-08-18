import { OpenAiChatAdapter } from "./openai-chat-adapter.js";

export const OPENCODE_GO_ADAPTER_ID = "opencode-go-direct";
export const OPENCODE_GO_ENDPOINT = "https://opencode.ai/zen/go/v1";

export class OpenCodeGoAdapter extends OpenAiChatAdapter {
  readonly id = OPENCODE_GO_ADAPTER_ID;
  protected readonly endpoint = OPENCODE_GO_ENDPOINT;
}
