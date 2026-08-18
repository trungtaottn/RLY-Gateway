import type { CredentialRef } from "./credential-ref.js";

export class SecretHandle {
  #value: string | undefined;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    if (this.#value === undefined) throw new Error("Secret handle has been disposed");
    return this.#value;
  }

  dispose(): void {
    // JavaScript strings cannot be zeroed. Disposal invalidates this handle only;
    // callers must keep the handle scoped and avoid copying the revealed value.
    this.#value = undefined;
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  toString(): string {
    return "[REDACTED]";
  }
}

export function resolveEnvironmentCredential(
  ref: CredentialRef,
  environment: NodeJS.ProcessEnv = process.env,
): SecretHandle {
  if (ref.kind !== "env") throw new Error(`Credential resolver does not support ${ref.kind}`);
  const value = environment[ref.name];
  if (!value) throw new Error(`Credential reference is not available: ${ref.name}`);
  return new SecretHandle(value);
}
