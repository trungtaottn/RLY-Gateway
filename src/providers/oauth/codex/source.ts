import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { ImportIncompatibleError } from "../../../credentials/errors.js";
import type { OAuthTokenSet } from "./protocol.js";

export const CODEX_IMPORT_MAX_BYTES = 64 * 1024;

export type CodexImportPreview = Readonly<{
  schema: "codex-auth";
  provider: "codex";
  sourceFingerprint: string;
  expiresAt: string | undefined;
}>;

export type CodexImportRead = Readonly<{
  preview: CodexImportPreview;
  tokens: OAuthTokenSet;
}>;

export async function readCodexAuthSource(path: string): Promise<CodexImportRead> {
  const first = await digestAndRead(path);
  const parsed = parseCodexAuthSource(first.contents);
  const second = await digestAndRead(path);
  if (second.fingerprint !== first.fingerprint) throw new ImportIncompatibleError("credential source changed during import");
  return {
    preview: {
      schema: "codex-auth",
      provider: "codex",
      sourceFingerprint: first.fingerprint,
      expiresAt: parsed.expiresAt,
    },
    tokens: parsed,
  };
}

export function parseCodexAuthSource(raw: string): OAuthTokenSet {
  if (raw.length > CODEX_IMPORT_MAX_BYTES) throw new ImportIncompatibleError("credential source is oversized");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ImportIncompatibleError("credential source is not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportIncompatibleError("credential source schema is unsupported");
  }
  const root = value as Record<string, unknown>;
  const tokens = isRecord(root["tokens"]) ? root["tokens"] : root;
  const accessToken = requiredToken(tokens["access_token"]);
  const refreshToken = requiredToken(tokens["refresh_token"]);
  return {
    accessToken,
    refreshToken,
    expiresAt: parseExpiry(root["expired"] ?? root["expires_at"] ?? tokens["expires_at"]),
    accountId: optionalToken(tokens["account_id"]),
  };
}

async function digestAndRead(path: string): Promise<{ fingerprint: string; contents: string }> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > CODEX_IMPORT_MAX_BYTES) {
    throw new ImportIncompatibleError("credential source is unreadable or oversized");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const contents = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(contents, "utf8") > CODEX_IMPORT_MAX_BYTES) {
      throw new ImportIncompatibleError("credential source is oversized");
    }
    return { fingerprint: createHash("sha256").update(contents).digest("hex"), contents };
  } finally {
    await handle.close();
  }
}

function parseExpiry(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ImportIncompatibleError("credential source expiry is invalid");
  return date.toISOString();
}

function requiredToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    throw new ImportIncompatibleError("credential source is missing required material");
  }
  return value;
}

function optionalToken(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
