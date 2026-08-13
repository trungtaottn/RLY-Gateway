import { z } from "zod";
import { assertProviderCredential, credentialRefSchema } from "../credentials/credential-ref.js";

const routeSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  credential: z.string().min(1),
});

const protectedPorts = new Set([10100, 8317, 17870]);

export const gatewayConfigSchema = z.object({
  schemaVersion: z.literal(1),
  gateway: z.object({
    host: z.literal("127.0.0.1").default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535)
      .refine((port) => !protectedPorts.has(port), "Protected port is unavailable to agent-gateway")
      .default(17871),
    logLevel: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
  }),
  routes: z.record(z.string().min(1), routeSchema).default({}),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;

export function validateCredentialRefs(config: GatewayConfig): void {
  for (const route of Object.values(config.routes)) {
    const separator = route.credential.indexOf(":");
    if (separator < 1) {
      throw new Error("Credential reference must use an approved kind:name syntax");
    }
    const kind = route.credential.slice(0, separator);
    const payload = route.credential.slice(separator + 1);
    if (kind !== "env") throw new Error("Credential reference kind is not enabled in bootstrap");
    const ref = credentialRefSchema.parse({ kind, name: payload });
    assertProviderCredential(route.provider, ref);
  }
}
