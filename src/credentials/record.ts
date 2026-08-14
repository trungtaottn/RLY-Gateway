import { z } from "zod";

export const CREDENTIAL_SCHEMA_VERSION = 1;
export const CREDENTIAL_PROVIDER_CODEX = "codex";

const materialSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384),
  accountId: z.string().min(1).max(256).optional(),
}).strict();

export const credentialRecordSchema = z.object({
  schemaVersion: z.literal(CREDENTIAL_SCHEMA_VERSION),
  provider: z.literal(CREDENTIAL_PROVIDER_CODEX),
  handle: z.string().regex(/^cred-[A-Za-z0-9_-]{1,64}$/),
  pseudonym: z.string().min(1).max(128),
  generation: z.number().int().positive(),
  expiresAt: z.iso.datetime().optional(),
  refreshFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  material: materialSchema,
}).strict();

export type CredentialRecord = z.infer<typeof credentialRecordSchema>;

export type CredentialMetadata = Readonly<{
  schemaVersion: number;
  provider: typeof CREDENTIAL_PROVIDER_CODEX;
  handle: string;
  pseudonym: string;
  generation: number;
  expiresAt: string | undefined;
  refreshFingerprint: string;
  sourceFingerprint: string | undefined;
}>;

export function parseCredentialRecord(value: unknown): CredentialRecord {
  return credentialRecordSchema.parse(value);
}

export function toCredentialMetadata(record: CredentialRecord): CredentialMetadata {
  return {
    schemaVersion: record.schemaVersion,
    provider: record.provider,
    handle: record.handle,
    pseudonym: record.pseudonym,
    generation: record.generation,
    expiresAt: record.expiresAt,
    refreshFingerprint: record.refreshFingerprint,
    sourceFingerprint: record.sourceFingerprint,
  };
}
