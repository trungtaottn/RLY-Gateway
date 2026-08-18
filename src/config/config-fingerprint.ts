import { createHash } from "node:crypto";
import type { GatewayConfig } from "./schema.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

/** Fingerprints non-secret declarative configuration with stable key ordering. */
export function fingerprintConfig(config: GatewayConfig): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(config))).digest("hex");
}
