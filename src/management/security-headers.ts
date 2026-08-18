export const MANAGEMENT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const MANAGEMENT_SECURITY_HEADERS = Object.freeze({
  "content-security-policy": MANAGEMENT_CSP,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
});

export function applyManagementSecurityHeaders(reply: { header: (name: string, value: string) => unknown }): void {
  for (const [name, value] of Object.entries(MANAGEMENT_SECURITY_HEADERS)) {
    reply.header(name, value);
  }
}
