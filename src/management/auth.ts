import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ManagementActor } from "../control-plane/types.js";
import { SESSION_COOKIE_NAME } from "./bootstrap-page.js";
import { parseCookie } from "./origin.js";
import type { SessionStore } from "./session-store.js";

export type ManagementAuthOptions = Readonly<{
  managementToken: string;
  instanceId: string;
  configFingerprint: string;
  sessions: SessionStore;
}>;

export type Principal = Readonly<{ actor: ManagementActor }>;

export type ManagementAuthorizer = (
  request: FastifyRequest,
  reply: FastifyReply,
  mutating: boolean,
) => Principal | undefined;

export const challengePattern = /^[A-Za-z0-9_-]{32,128}$/;

export function createManagementIdentityProof(
  managementToken: string,
  challenge: string,
  instanceId: string,
  configFingerprint: string,
): string {
  return createHmac("sha256", managementToken)
    .update(["rly-gateway-management", "1", challenge, instanceId, configFingerprint].join("\n"))
    .digest("hex");
}

export function createAuthorizer(options: ManagementAuthOptions): ManagementAuthorizer {
  return (request, reply, mutating) => {
    const bearer = bearerToken(request.headers.authorization);
    if (bearer !== undefined) {
      if (!bearerMatches(bearer, options.managementToken)) {
        void reject(reply, 401, "unauthorized");
        return undefined;
      }
      return { actor: "cli" };
    }
    const sessionId = parseCookie(headerValue(request.headers.cookie), SESSION_COOKIE_NAME);
    if (!sessionId || !options.sessions.hasSession(sessionId)) {
      void reject(reply, 401, "unauthorized");
      return undefined;
    }
    if (mutating) {
      const csrf = headerValue(request.headers["x-csrf-token"]);
      if (!csrf || !options.sessions.matchesCsrf(sessionId, csrf)) {
        void reject(reply, 403, "invalid-csrf");
        return undefined;
      }
    }
    return { actor: "browser" };
  };
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function reject(reply: FastifyReply, status: number, code: string): FastifyReply {
  return reply.code(status).send({ error: code });
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function bearerMatches(actual: string, expected: string): boolean {
  const left = createHash("sha256").update(actual).digest();
  const right = createHash("sha256").update(expected).digest();
  return left.length === right.length && timingSafeEqual(left, right);
}
