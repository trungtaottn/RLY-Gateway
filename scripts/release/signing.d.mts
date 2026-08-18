// Type declarations for scripts/release/signing.mjs (release signing, #128).

export type SignatureEnvelope = {
  algorithm: "ed25519";
  schemaVersion: 1;
  keyFingerprint: string;
  signature: string;
};

export const SIGNING_ALGORITHM: "ed25519";
export const SIGNATURE_SCHEMA_VERSION: 1;

export function canonicalJsonStringify(value: unknown): string;
export function generateSigningKeyPair(): { publicKey: string; privateKey: string };
export function publicKeyFingerprint(keyPem: string): string;
export function signBytes(privateKeyPem: string, data: Uint8Array | string): SignatureEnvelope;
export function verifySignature(publicKeyPem: string, data: Uint8Array | string, envelope: SignatureEnvelope): boolean;
export function signJson(privateKeyPem: string, value: unknown): SignatureEnvelope;
export function verifyJsonSignature(publicKeyPem: string, value: unknown, envelope: SignatureEnvelope): boolean;
export function signDigestStatement(privateKeyPem: string, sha256Hex: string): SignatureEnvelope;
export function verifyDigestStatement(publicKeyPem: string, sha256Hex: string, envelope: SignatureEnvelope): boolean;
