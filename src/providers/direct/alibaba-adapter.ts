import { OpenAiChatAdapter } from "./openai-chat-adapter.js";

export const ALIBABA_ADAPTER_ID = "alibaba-direct";
export const ALIBABA_ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** Terms gating is eligibility-owned via requiredTermsRevision. This adapter is transport only. */
export class AlibabaAdapter extends OpenAiChatAdapter {
  readonly id = ALIBABA_ADAPTER_ID;
  protected readonly endpoint = ALIBABA_ENDPOINT;
}
