import { z } from "zod";

const approvedEnvName = z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/);

const providerCredentialNames: Readonly<Record<string, readonly string[]>> = {
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  "opencode-go": ["OPENCODE_GO_API_KEY"],
  "alibaba-token-plan": ["ALIBABA_TOKEN_PLAN_API_KEY"],
};

export const credentialRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("env"), name: approvedEnvName }),
  z.object({ kind: z.literal("handle"), handle: z.string().regex(/^cred-[A-Za-z0-9_-]{1,64}$/) }),
  z.object({ kind: z.literal("keychain"), service: z.string().min(1), account: z.string().min(1) }),
]);

export type CredentialRef = z.infer<typeof credentialRefSchema>;

export function parseCredentialRef(value: string): CredentialRef {
  const separator = value.indexOf(":");
  if (separator < 1) throw new Error("Credential reference must use kind:value syntax");
  const kind = value.slice(0, separator);
  const payload = value.slice(separator + 1);
  if (kind === "env") return credentialRefSchema.parse({ kind, name: payload });
  if (kind === "handle") return credentialRefSchema.parse({ kind, handle: payload });
  throw new Error(`Unsupported credential reference kind: ${kind}`);
}

export function assertProviderCredential(provider: string, ref: CredentialRef): void {
  if (ref.kind === "handle") {
    if (provider !== "codex") throw new Error("Credential reference is not approved for the selected provider");
    return;
  }
  if (ref.kind !== "env") return;
  const allowed = providerCredentialNames[provider];
  if (!allowed?.includes(ref.name)) {
    throw new Error("Credential reference is not approved for the selected provider");
  }
}
