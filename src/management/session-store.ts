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
    const token = randomBytes(32).toString("base64url");
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
    const id = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const sessionExpires = this.clock().getTime() + SESSION_TTL_MS;
    this.#sessions.set(hashToken(id), { expiresAt: sessionExpires, csrfHash: hashToken(csrfToken) });
    return { id, csrfToken, expiresAt: sessionExpires };
  }

  public hasSession(id: string): boolean {
    this.purge();
    const session = this.#sessions.get(hashToken(id));
    return session !== undefined && session.expiresAt > this.clock().getTime();
  }

  public matchesCsrf(id: string, csrfToken: string): boolean {
    this.purge();
    const session = this.#sessions.get(hashToken(id));
    return session !== undefined
      && session.expiresAt > this.clock().getTime()
      && safeEqual(session.csrfHash, hashToken(csrfToken));
  }

  public revoke(id: string): void {
    this.#sessions.delete(hashToken(id));
  }

  public revokeAll(): void {
    this.#bootstraps.clear();
    this.#sessions.clear();
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

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
