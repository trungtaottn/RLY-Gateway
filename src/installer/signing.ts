import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";

/**
 * RLY release signing verification (#128) — TypeScript mirror of
 * `scripts/release/signing.mjs` used by the verified installer/updater.
 *
 * Verifies Ed25519 detached signatures over release metadata (canonical JSON
 * bytes) and over artifact digest statements (`sha256:<hex>\n`). The PRIVATE
 * key never exists in this module or the repository; only the committed
 * public key is used. A regression test cross-verifies signatures produced by
 * `scripts/release/signing.mjs` (the publisher side) so the two
 * implementations can never drift.
 *
 * No credentials, tokens, prompts, responses, or user content ever enter this
 * module or its outputs.
 */

export const SIGNING_ALGORITHM = "ed25519";
export const SIGNATURE_SCHEMA_VERSION = 1;

export const signatureEnvelopeSchema = z.object({
  algorithm: z.literal(SIGNING_ALGORITHM),
  schemaVersion: z.literal(SIGNATURE_SCHEMA_VERSION),
  keyFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().min(1),
});

export type SignatureEnvelope = z.infer<typeof signatureEnvelopeSchema>;

/**
 * Canonical JSON serialization (sorted object keys, no whitespace) — the exact
 * byte contract signed by the release publisher (`canonicalJsonStringify` in
 * `scripts/release/signing.mjs`). Both sides must agree byte-for-byte or every
 * signature verification fails closed.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("cannot canonicalize non-finite number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJsonStringify(v)}`).join(",")}}`;
}

const PUBLIC_KEY_MARKER = "-----BEGIN " + "PUBLIC KEY-----";

function publicKeyDer(publicKeyPem: string): Buffer {
  if (typeof publicKeyPem !== "string" || !publicKeyPem.includes(PUBLIC_KEY_MARKER)) {
    throw new Error("invalid public key PEM");
  }
  return Buffer.from(
    publicKeyPem
      .split("\n")
      .filter((line) => !line.startsWith("-----"))
      .join(""),
    "base64",
  );
}

/** SHA-256 fingerprint of the public key DER (stable identifier for metadata). */
export function publicKeyFingerprint(keyPem: string): string {
  return createHash("sha256").update(publicKeyDer(keyPem)).digest("hex");
}

/**
 * Verifies a detached signature envelope over raw bytes. Throws on invalid
 * envelope shape; returns the Ed25519 verification boolean.
 */
export function verifySignature(publicKeyPem: string, data: string | Uint8Array, envelope: unknown): boolean {
  const parsed = signatureEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error(`signature envelope is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  if (parsed.data.keyFingerprint !== publicKeyFingerprint(publicKeyPem)) {
    throw new Error(
      `signature key fingerprint ${parsed.data.keyFingerprint} does not match the release public key`,
    );
  }
  const key = createPublicKey(publicKeyPem);
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return verify(null, bytes, key, Buffer.from(parsed.data.signature, "base64"));
}

/** Verifies a detached envelope over a JSON value's canonical bytes. */
export function verifyJsonSignature(publicKeyPem: string, value: unknown, envelope: unknown): boolean {
  return verifySignature(publicKeyPem, canonicalJsonStringify(value), envelope);
}

/** Verifies a signed `sha256:<hex>` artifact digest statement. */
export function verifyDigestStatement(publicKeyPem: string, sha256Hex: string, envelope: unknown): boolean {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error(`invalid sha256 digest for verification: ${sha256Hex}`);
  return verifySignature(publicKeyPem, `sha256:${sha256Hex}\n`, envelope);
}
