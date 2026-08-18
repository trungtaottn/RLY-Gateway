const FORBIDDEN_KEYS = [
  "accessToken",
  "refreshToken",
  "authorization",
  "token",
  "secret",
  "password",
  "email",
  "prompt",
  "response",
  "identity",
] as const;

export function assertSecretFree(value: unknown): void {
  walk(value, (key) => {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      throw new Error("management DTO must not serialize secret or identity fields");
    }
  });
}

function walk(value: unknown, visit: (key: string) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key);
    walk(child, visit);
  }
}
