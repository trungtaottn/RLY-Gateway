import type { OpaqueArtifact } from "./fidelity.js";

type EventBase = Readonly<{
  requestId: string;
  sequence: number;
  timestamp: string;
  providerId: string;
  modelId: string;
}>;

export type CanonicalEvent =
  | (EventBase & { type: "response-started"; responseId: string })
  | (EventBase & { type: "content-started"; index: number; contentType: "text" | "reasoning" | "redacted-reasoning" | "tool-call"; toolCallId?: string; toolName?: string; /** #121: provider-assigned Responses item id preserved onto the wire. */ itemId?: string })
  | (EventBase & { type: "text-delta"; index: number; text: string })
  | (EventBase & { type: "reasoning-delta"; index: number; text: string })
  | (EventBase & { type: "signature-delta"; index: number; signature: string })
  | (EventBase & { type: "tool-arguments-delta"; index: number; toolCallId: string; partialJson: string })
  | (EventBase & { type: "content-completed"; index: number })
  | (EventBase & { type: "usage-updated"; inputTokens?: number; outputTokens?: number })
  | (EventBase & { type: "response-completed"; stopReason: string })
  | (EventBase & { type: "response-failed"; code: string; message: string })
  /** #121: opaque continuation artifacts discovered in a provider response (e.g. Responses reasoning `encrypted_content`). Encoders emit no wire frame; they attach the artifacts to the terminal aggregate. */
  | (EventBase & { type: "fidelity-artifacts"; artifacts: readonly OpaqueArtifact[] });
