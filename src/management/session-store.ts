import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "../control-plane/types.js";

export const BOOTSTRAP_TTL_MS = 60_000;
export const SESSION_TTL_MS = 30 * 60_000;

export type SessionRecord = Readonly<{
  id: string;
  csrfToken: string;
  expiresAt: number;
}>;

type StoredSession = Readonly<{ expiresAt: number; csrfHash: string }>;

export class SessionStore {
  readonly #bootstraps = new Map<string, number>();
  readonly #sessions = new Map<string, StoredSession>();

  public constructor(readonly clock: Clock = () => new Date()) {}

  public issueBootstrap(): { token: string; expiresAt: number } {
    this.purge();
    const token = randomToken();
    const expiresAt = this.clock().getTime() + BOOTSTRAP_TTL_MS;
    this.#bootstraps.set(hashToken(token), expiresAt);
    return { token, expiresAt };
  }

  public exchangeBootstrap(token: string): SessionRecord | undefined {
    this.purge();
    const hashed = hashToken(token);
    const expiresAt = this.#bootstraps.get(hashed);
    this.#bootstraps.delete(hashed);
    if (expiresAt === undefined || expiresAt <= this.clock().getTime()) return undefined;
    const id = randomToken();
    const csrfToken = randomToken();
    const sessionExpires = this.clock().getTime() + SESSION_TTL_MS;
    this.#sessions.set(hashToken(id), { expiresAt: sessionExpires, csrfHash: hashToken(csrfToken) });
    return { id, csrfToken, expiresAt: sessionExpires };
  }

  public hasSession(id: string): boolean {
    return this.liveSession(id) !== undefined;
  }

  public matchesCsrf(id: string, csrfToken: string): boolean {
    const session = this.liveSession(id);
    return session !== undefined && safeEqual(session.csrfHash, hashToken(csrfToken));
  }

  public rotateCsrf(id: string): SessionRecord | undefined {
    const session = this.liveSession(id);
    if (session === undefined) return undefined;
    const csrfToken = randomToken();
    this.#sessions.set(hashToken(id), { expiresAt: session.expiresAt, csrfHash: hashToken(csrfToken) });
    return { id, csrfToken, expiresAt: session.expiresAt };
  }

  public revoke(id: string): void {
    this.#sessions.delete(hashToken(id));
  }

  public revokeAll(): void {
    this.#bootstraps.clear();
    this.#sessions.clear();
  }

  private liveSession(id: string): StoredSession | undefined {
    this.purge();
    const session = this.#sessions.get(hashToken(id));
    return session !== undefined && session.expiresAt > this.clock().getTime() ? session : undefined;
  }

  private purge(): void {
    const now = this.clock().getTime();
    for (const [key, expiresAt] of this.#bootstraps) {
      if (expiresAt <= now) this.#bootstraps.delete(key);
    }
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(key);
    }
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
