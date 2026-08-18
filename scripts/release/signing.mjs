#!/usr/bin/env node
// RLY release signing primitives (#128).
//
// Ed25519 detached signatures over release metadata (canonical JSON bytes)
// and over artifact digests (`sha256:<hex>\n`). The PRIVATE key NEVER enters
// the repository: publish-time signing reads it from `RLY_RELEASE_SIGNING_KEY`
// (a GitHub Actions secret) or an explicit file path supplied at the CLI. The
// PUBLIC key is committed at `scripts/release/signing-public-key.pem` so every
// verifier (CI, updater, tooling) can check release assets without any secret.
//
// No credentials, tokens, prompts, responses, or user content ever enter this
// module or its outputs.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { Buffer } from "node:buffer";

export const SIGNING_ALGORITHM = "ed25519";
export const SIGNATURE_SCHEMA_VERSION = 1;

/** Canonical JSON serialization (sorted object keys) for signing/verification. */
export function canonicalJsonStringify(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("cannot canonicalize non-finite number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonStringify(item)).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJsonStringify(v)}`).join(",")}}`;
}

/** Generates an Ed25519 key pair and returns both PEM exports. */
export function generateSigningKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

const PRIVATE_KEY_MARKER = "-----BEGIN " + "PRIVATE KEY-----";
const PUBLIC_KEY_MARKER = "-----BEGIN " + "PUBLIC KEY-----";

/** SHA-256 fingerprint of the public key DER (stable identifier for metadata). */
export function publicKeyFingerprint(keyPem) {
  const publicKey = keyPem.includes(PRIVATE_KEY_MARKER)
    ? exportPublicKey(keyPem)
    : keyPem;
  const der = publicKeyDer(publicKey);
  return createHash("sha256").update(der).digest("hex");
}

function publicKeyDer(publicKeyPem) {
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

/**
 * Signs raw bytes and returns the detached signature envelope (base64
 * signature + algorithm + key fingerprint, never the key).
 */
export function signBytes(privateKeyPem, data) {
  const key = importKey(privateKeyPem, "private");
  const signature = sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"), key);
  return {
    algorithm: SIGNING_ALGORITHM,
    schemaVersion: SIGNATURE_SCHEMA_VERSION,
    keyFingerprint: publicKeyFingerprint(exportPublicKey(privateKeyPem)),
    signature: signature.toString("base64"),
  };
}

function exportPublicKey(privateKeyPem) {
  if (typeof privateKeyPem !== "string" || !privateKeyPem.includes(PRIVATE_KEY_MARKER)) {
    throw new Error("invalid private key PEM (expected PKCS#8)");
  }
  const key = importKey(privateKeyPem, "private");
  return createPublicKey(key).export({ type: "spki", format: "pem" });
}

function importKey(pem, kind) {
  if (typeof pem !== "string") throw new Error(`invalid ${kind} key PEM`);
  return createPrivateKeyOrPublicKey(pem, kind);
}

function createPrivateKeyOrPublicKey(pem, kind) {
  try {
    return kind === "private" ? createPrivateKey(pem) : createPublicKey(pem);
  } catch (error) {
    throw new Error(`cannot import ${kind} key: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Verifies a detached signature envelope over raw bytes. Throws on invalid shape. */
export function verifySignature(publicKeyPem, data, envelope) {
  if (envelope === undefined || envelope === null || typeof envelope !== "object") {
    throw new Error("missing signature envelope");
  }
  if (envelope.algorithm !== SIGNING_ALGORITHM) {
    throw new Error(`unsupported signature algorithm: ${envelope.algorithm ?? "(missing)"}`);
  }
  if (envelope.schemaVersion !== SIGNATURE_SCHEMA_VERSION) {
    throw new Error(`unsupported signature schemaVersion: ${envelope.schemaVersion ?? "(missing)"}`);
  }
  if (envelope.keyFingerprint !== publicKeyFingerprint(publicKeyPem)) {
    throw new Error(
      `signature key fingerprint ${envelope.keyFingerprint ?? "(missing)"} does not match the release public key`,
    );
  }
  if (typeof envelope.signature !== "string" || envelope.signature.length === 0) {
    throw new Error("signature envelope carries no signature");
  }
  const key = createPublicKey(publicKeyPem);
  return verify(null, Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"), key, Buffer.from(envelope.signature, "base64"));
}

/** Signs a JSON value (canonical bytes) and returns the detached envelope. */
export function signJson(privateKeyPem, value) {
  return signBytes(privateKeyPem, canonicalJsonStringify(value));
}

/** Verifies a detached envelope over a JSON value's canonical bytes. */
export function verifyJsonSignature(publicKeyPem, value, envelope) {
  return verifySignature(publicKeyPem, canonicalJsonStringify(value), envelope);
}

/** Signs a `sha256:<hex>` digest statement (the artifact trust chain). */
export function signDigestStatement(privateKeyPem, sha256Hex) {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error(`invalid sha256 digest for signing: ${sha256Hex}`);
  return signBytes(privateKeyPem, `sha256:${sha256Hex}\n`);
}

/** Verifies a signed `sha256:<hex>` statement. */
export function verifyDigestStatement(publicKeyPem, sha256Hex, envelope) {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error(`invalid sha256 digest for verification: ${sha256Hex}`);
  return verifySignature(publicKeyPem, `sha256:${sha256Hex}\n`, envelope);
}
