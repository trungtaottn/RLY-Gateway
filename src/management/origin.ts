export function managementOrigin(host: "127.0.0.1", port: number): string {
  return `http://${host}:${String(port)}`;
}

export function isExactManagementOrigin(origin: string | undefined, expected: string): boolean {
  return origin === expected;
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(maxAgeSeconds)}`;
}

export function expiredSessionCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
