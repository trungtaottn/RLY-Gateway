import { z } from "zod";

/**
 * Protocol-preservation representation (#119).
 *
 * RLY is a protocol-preserving gateway first and a model router second. The
 * semantic canonical core (`CanonicalRequest` / `CanonicalEvent`) stays the
 * routing projection; a versioned fidelity envelope carries the wire-significant
 * opaque continuation artifacts that semantic routing must never interpret or
 * drop. Native protocol rails (the encoder/decoder wire shapes) remain the
 * source of wire truth for same-protocol traffic.
 *
 * PRIVACY INVARIANT: opaque artifact values are runtime/protocol state, NOT
 * diagnostics. Never log them, never place them in route traces, and never
 * include them in normal diagnostic bundles. `describeFidelity()` is the only
 * diagnostic surface and it exposes provenance metadata only (kinds,
 * dispositions, field names, counts) — never artifact values.
 */

export const FIDELITY_ENVELOPE_VERSION = 1 as const;

export type FidelitySourceProtocol = "anthropic-messages" | "openai-responses";

export const OPAQUE_ARTIFACT_KINDS = [
  "anthropic-thinking-signature",
  "openai-reasoning-encrypted-content",
] as const;

/**
 * Typed opaque continuation artifacts. Values are never interpreted by
 * semantic routing: routing may inspect only explicitly modeled safe metadata
 * (kind, association, disposition), never the artifact value.
 */
export type OpaqueArtifactKind = (typeof OPAQUE_ARTIFACT_KINDS)[number];

export type OpaqueArtifact = Readonly<{
  kind: OpaqueArtifactKind;
  /**
   * Stable association key (message/block/item index or id) that ties the
   * artifact back to its owning item/block. Not secret-bearing itself.
   */
  association: string;
  /** Opaque provider/client-owned value. Never interpreted, never logged. */
  value: string;
}>;

export const FIDELITY_DISPOSITIONS = ["preserved-native", "translated", "ignored", "unsupported"] as const;

/** How a wire field/artifact was handled across a translation boundary. */
export type FidelityDisposition = (typeof FIDELITY_DISPOSITIONS)[number];

export type FidelityNote = Readonly<{
  /** The wire field/path this note describes. */
  field: string;
  disposition: FidelityDisposition;
  reason?: string;
}>;

export type FidelityEnvelope = Readonly<{
  version: typeof FIDELITY_ENVELOPE_VERSION;
  sourceProtocol: FidelitySourceProtocol;
  protocolRevision?: string;
  /** Opaque continuation artifacts preserved without interpretation. */
  artifacts: readonly OpaqueArtifact[];
  /** Translation provenance for wire-significant fields/artifacts. */
  notes: readonly FidelityNote[];
  /** Artifact kinds that MUST survive re-encode/continuation (fail closed otherwise). */
  required: readonly OpaqueArtifactKind[];
}>;

export function emptyFidelityEnvelope(
  sourceProtocol: FidelitySourceProtocol,
  protocolRevision?: string,
): FidelityEnvelope {
  return Object.freeze({
    version: FIDELITY_ENVELOPE_VERSION,
    sourceProtocol,
    ...(protocolRevision === undefined ? {} : { protocolRevision }),
    artifacts: Object.freeze([]),
    notes: Object.freeze([]),
    required: Object.freeze([]),
  });
}

export function withArtifacts(envelope: FidelityEnvelope, artifacts: readonly OpaqueArtifact[]): FidelityEnvelope {
  if (artifacts.length === 0) return envelope;
  return Object.freeze({ ...envelope, artifacts: Object.freeze([...envelope.artifacts, ...artifacts]) });
}

export function withNotes(envelope: FidelityEnvelope, notes: readonly FidelityNote[]): FidelityEnvelope {
  if (notes.length === 0) return envelope;
  return Object.freeze({ ...envelope, notes: Object.freeze([...envelope.notes, ...notes]) });
}

export function withRequired(envelope: FidelityEnvelope, kinds: readonly OpaqueArtifactKind[]): FidelityEnvelope {
  if (kinds.length === 0) return envelope;
  const merged = [...new Set([...envelope.required, ...kinds])];
  return Object.freeze({ ...envelope, required: Object.freeze(merged) });
}

/** Merges a continuation envelope's artifacts/notes into a fresh envelope without touching values. */
export function mergeFidelity(base: FidelityEnvelope | undefined, extra: FidelityEnvelope | undefined): FidelityEnvelope | undefined {
  if (base === undefined && extra === undefined) return undefined;
  if (base === undefined) return extra;
  if (extra === undefined) return base;
  return Object.freeze({
    ...base,
    artifacts: Object.freeze([...base.artifacts, ...extra.artifacts]),
    notes: Object.freeze([...base.notes, ...extra.notes]),
    required: Object.freeze([...new Set([...base.required, ...extra.required])]),
  });
}

/** Looks up the first artifact of a kind associated with a stable key. */
export function artifactValue(
  envelope: FidelityEnvelope | undefined,
  kind: OpaqueArtifactKind,
  association: string,
): string | undefined {
  return envelope?.artifacts.find((artifact) => artifact.kind === kind && artifact.association === association)?.value;
}

/**
 * Returns the artifact kinds that a translation path cannot carry. Used by the
 * fail-closed policy: a compatibility claim requiring an artifact cannot pass
 * when the selected path cannot preserve it.
 */
export function unsupportedRequiredArtifacts(
  envelope: FidelityEnvelope | undefined,
  supported: readonly OpaqueArtifactKind[],
): OpaqueArtifactKind[] {
  if (envelope === undefined) return [];
  return envelope.required.filter((kind) => !supported.includes(kind));
}

/** Diagnostic-only summary. Never exposes artifact values. */
export type FidelitySummary = Readonly<{
  version: number;
  sourceProtocol: FidelitySourceProtocol;
  protocolRevision?: string;
  artifactKinds: readonly string[];
  artifactCount: number;
  notes: readonly Readonly<{ field: string; disposition: FidelityDisposition }>[];
  requiredKinds: readonly string[];
}>;

export function describeFidelity(envelope: FidelityEnvelope): FidelitySummary {
  return Object.freeze({
    version: envelope.version,
    sourceProtocol: envelope.sourceProtocol,
    ...(envelope.protocolRevision === undefined ? {} : { protocolRevision: envelope.protocolRevision }),
    artifactKinds: Object.freeze([...new Set(envelope.artifacts.map((artifact) => artifact.kind))]),
    artifactCount: envelope.artifacts.length,
    notes: Object.freeze(envelope.notes.map((note) => Object.freeze({ field: note.field, disposition: note.disposition }))),
    requiredKinds: Object.freeze([...envelope.required]),
  });
}

/** Zod schema for persisting/validating a fidelity envelope (continuation storage). */
export const fidelityEnvelopeSchema = z.object({
  version: z.literal(FIDELITY_ENVELOPE_VERSION),
  sourceProtocol: z.enum(["anthropic-messages", "openai-responses"]),
  protocolRevision: z.string().optional(),
  artifacts: z.array(z.object({
    kind: z.enum(OPAQUE_ARTIFACT_KINDS),
    association: z.string(),
    value: z.string(),
  })),
  notes: z.array(z.object({
    field: z.string(),
    disposition: z.enum(FIDELITY_DISPOSITIONS),
    reason: z.string().optional(),
  })),
  required: z.array(z.enum(OPAQUE_ARTIFACT_KINDS)),
});
