import { z } from "zod";
import type { CanonicalContent, CanonicalMessage, CanonicalRequest } from "../../core/canonical-request.js";
import { artifactValue, emptyFidelityEnvelope, fidelityEnvelopeSchema, mergeFidelity, withArtifacts, type FidelityEnvelope } from "../../core/fidelity.js";
import { controlPlanePaths } from "../../storage/paths.js";
import {
  ensurePrivateDirectory,
  listPrivateDirectory,
  readPrivateTextIfPresent,
  removePrivateFileIfPresent,
  writePrivateTextAtomically,
} from "../../storage/private-files.js";
import { ResponsesProtocolError } from "./decoder.js";
import { aggregateResponsesEvents } from "./encoder.js";
import type { CanonicalEvent } from "../../core/canonical-event.js";
import { join } from "node:path";

const storedSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.array(z.unknown()),
  })),
  fidelity: fidelityEnvelopeSchema.optional(),
}).strict();

export type StoredResponse = Readonly<{
  id: string;
  createdAt: string;
  model: string;
  messages: readonly CanonicalMessage[];
  /** #119: opaque continuation artifacts + provenance carried across turns. */
  fidelity?: FidelityEnvelope;
}>;

function textField(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record["text"] === "string" ? record["text"] : undefined;
}

function parseJsonOrRaw(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function messagesFromOutput(output: readonly unknown[]): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null || !("type" in item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type === "message") {
      const content = Array.isArray(record.content) ? record.content : [];
      const texts = content.flatMap((part): CanonicalContent[] => {
        const text = textField(part);
        return text === undefined ? [] : [{ type: "text", text }];
      });
      if (texts.length > 0) messages.push({ role: "assistant", content: texts });
      continue;
    }
    if (record.type === "function_call") {
      const input = typeof record.arguments === "string" ? parseJsonOrRaw(record.arguments) : {};
      const name = typeof record.name === "string" ? record.name : "unknown";
      const callId = typeof record.call_id === "string" ? record.call_id : typeof record.id === "string" ? record.id : "tool";
      messages.push({ role: "assistant", content: [{ type: "tool-call", id: callId, name, input }] });
      continue;
    }
    if (record.type === "reasoning") {
      const summary = Array.isArray(record.summary) ? record.summary : [];
      const itemId = typeof record.id === "string" ? record.id : undefined;
      messages.push({
        role: "assistant",
        content: [{ type: "reasoning", text: summary.map((part) => textField(part) ?? "").join("\n"), ...(itemId === undefined ? {} : { id: itemId }) }],
      });
    }
  }
  return messages;
}

/**
 * #121: extracts provider-returned opaque artifacts (reasoning
 * `encrypted_content`) from an aggregated Responses output so they survive
 * into the stored fidelity envelope for continuation. Values are protocol
 * state, never interpreted, never logged.
 */
function artifactsFromAggregated(output: readonly unknown[]): Readonly<{ kind: "openai-reasoning-encrypted-content"; association: string; value: string }>[] {
  const artifacts: Readonly<{ kind: "openai-reasoning-encrypted-content"; association: string; value: string }>[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null || !("type" in item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "reasoning") continue;
    const itemId = typeof record.id === "string" ? record.id : undefined;
    const encrypted = typeof record.encrypted_content === "string" && record.encrypted_content.length > 0 ? record.encrypted_content : undefined;
    if (itemId === undefined || encrypted === undefined) continue;
    artifacts.push({ kind: "openai-reasoning-encrypted-content", association: itemId, value: encrypted });
  }
  return artifacts;
}

function fidelityForStorage(request: CanonicalRequest, output: readonly unknown[]): FidelityEnvelope | undefined {
  const providerArtifacts = artifactsFromAggregated(output);
  if (providerArtifacts.length === 0) return request.fidelity;
  const envelope = withArtifacts(emptyFidelityEnvelope("openai-responses"), providerArtifacts);
  return mergeFidelity(request.fidelity, envelope);
}

function fileFor(directory: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ResponsesProtocolError("invalid_request_error", "previous_response_id is not a stored response id");
  return join(controlPlanePaths(directory).responses, `${id}.json`);
}

export class ResponseContinuationStore {
  constructor(private readonly directory: string) {}

  public async prepare(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    await ensurePrivateDirectory(controlPlanePaths(this.directory).responses);
  }

  public async get(id: string): Promise<StoredResponse | undefined> {
    await this.prepare();
    const raw = await readPrivateTextIfPresent(fileFor(this.directory, id));
    if (raw === undefined) return undefined;
    const parsed = storedSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return undefined;
    return {
      id: parsed.data.id,
      createdAt: parsed.data.createdAt,
      model: parsed.data.model,
      messages: parsed.data.messages as CanonicalMessage[],
      ...(parsed.data.fidelity === undefined ? {} : { fidelity: parsed.data.fidelity as FidelityEnvelope }),
    };
  }

  public async put(record: StoredResponse): Promise<void> {
    await this.prepare();
    await writePrivateTextAtomically(fileFor(this.directory, record.id), `${JSON.stringify(record)}\n`);
  }

  public async apply(request: CanonicalRequest): Promise<CanonicalRequest> {
    const previousId = request.continuation?.previousResponseId;
    if (previousId === undefined) return request;
    const previous = await this.get(previousId);
    if (!previous) throw new ResponsesProtocolError("compatibility_unready", "previous_response_id is unknown or expired", 409);
    // #119: opaque continuation artifacts (encrypted reasoning content) ride
    // the fidelity envelope into the next turn; never reconstructed from text.
    const fidelity = mergeFidelity(previous.fidelity, request.fidelity);
    return {
      ...request,
      messages: [...previous.messages, ...request.messages],
      input: [...previous.messages.flatMap((message) => message.content), ...request.input],
      ...(fidelity === undefined ? {} : { fidelity }),
    };
  }

  public async rememberAggregated(request: CanonicalRequest, aggregated: Readonly<{ id: string; model: string; output: readonly unknown[] }>): Promise<StoredResponse | undefined> {
    const output = Array.isArray(aggregated.output) ? aggregated.output : [];
    const fidelity = fidelityForStorage(request, output);
    const stored: StoredResponse = {
      id: aggregated.id,
      createdAt: new Date().toISOString(),
      model: aggregated.model,
      messages: [...request.messages, ...messagesFromOutput(output)],
      ...(fidelity === undefined ? {} : { fidelity }),
    };
    await this.put(stored);
    return stored;
  }

  public async remember(request: CanonicalRequest, events: readonly CanonicalEvent[]): Promise<StoredResponse | undefined> {
    const started = events.find((item) => item.type === "response-started");
    const completed = events.some((item) => item.type === "response-completed");
    if (!started || !completed) return undefined;
    const aggregated = aggregateResponsesEvents(events);
    return this.rememberAggregated(request, { id: String(aggregated.id), model: String(aggregated.model), output: Array.isArray(aggregated.output) ? aggregated.output : [] });
  }

  public toResponsesObject(stored: StoredResponse): Record<string, unknown> {
    const output: Record<string, unknown>[] = [];
    for (const message of stored.messages) {
      if (message.role !== "assistant") continue;
      for (const item of message.content) {
        if (item.type === "text") output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: item.text }] });
        if (item.type === "tool-call") output.push({ type: "function_call", call_id: item.id, name: item.name, arguments: JSON.stringify(item.input) });
        if (item.type === "reasoning") {
          const association = item.id ?? "reasoning-item";
          const encrypted = artifactValue(stored.fidelity, "openai-reasoning-encrypted-content", association);
          output.push({
            type: "reasoning",
            ...(item.id === undefined ? {} : { id: item.id }),
            summary: [{ type: "summary_text", text: item.text }],
            ...(encrypted === undefined ? {} : { encrypted_content: encrypted }),
          });
        }
      }
    }
    return { id: stored.id, object: "response", status: "completed", model: stored.model, output };
  }

  public async list(): Promise<string[]> {
    await this.prepare();
    const names = await listPrivateDirectory(controlPlanePaths(this.directory).responses);
    return names.filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, ""));
  }

  public async remove(id: string): Promise<void> {
    await removePrivateFileIfPresent(fileFor(this.directory, id));
  }
}
