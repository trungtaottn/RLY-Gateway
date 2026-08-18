import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { gatewayConfigSchema, validateCredentialRefs, type GatewayConfig } from "./schema.js";

export async function loadConfig(path: string): Promise<GatewayConfig> {
  const text = await readFile(path, "utf8");
  const config = gatewayConfigSchema.parse(parse(text));
  validateCredentialRefs(config);
  return config;
}

