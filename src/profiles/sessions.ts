import { createHash, randomBytes } from "node:crypto";
import type { ModelUniverseSnapshot } from "../routing/model-projection/types.js";

export type LaunchSession = Readonly<{
  profileId: string;
  profileName: string;
  leaseId: string;
  /**
   * Session-pinned model universe (#72): compiled at issue time from the
   * control-plane policy so an active session never sees a silently remapped
   * projection target.
   */
  modelUniverse: ModelUniverseSnapshot;
}>;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** In-memory child tokens bound to a live lease and profile. Activation never stores an account. */
export class LaunchSessionRegistry {
  private readonly sessions = new Map<string, LaunchSession>();

  public constructor(private readonly leaseActive: (leaseId: string) => boolean = () => true) {}

  public issue(input: Readonly<{ profileId: string; profileName: string; leaseId: string; modelUniverse: ModelUniverseSnapshot }>): string {
    if (!this.leaseActive(input.leaseId)) throw new Error("lease-not-active");
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(tokenHash(token), {
      profileId: input.profileId,
      profileName: input.profileName,
      leaseId: input.leaseId,
      modelUniverse: input.modelUniverse,
    });
    return token;
  }

  public resolve(token: string): LaunchSession | undefined {
    const hash = tokenHash(token);
    const session = this.sessions.get(hash);
    if (session === undefined) return undefined;
    if (this.leaseActive(session.leaseId)) return session;
    this.sessions.delete(hash);
    return undefined;
  }

  public dropLease(leaseId: string): void {
    for (const [hash, session] of this.sessions) {
      if (session.leaseId === leaseId) this.sessions.delete(hash);
    }
  }

  public size(): number {
    return this.sessions.size;
  }
}
