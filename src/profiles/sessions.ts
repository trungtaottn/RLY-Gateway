import { createHash, randomBytes } from "node:crypto";
import type { ModelUniverseSnapshot, SessionPolicySnapshot } from "../routing/model-projection/types.js";
import { deriveClaudeViewId } from "../runtime/claude-overlay.js";

export type LaunchSession = Readonly<{
  profileId: string;
  profileName: string;
  leaseId: string;
  /**
   * Deterministic profile-scoped Claude view identity (#126): the durable
   * `CLAUDE_CONFIG_DIR` view this session's RLY-only model/default/cache/
   * history state belongs to. Derived from the immutable profile id.
   */
  viewId: string;
  /**
   * Session-pinned model universe (#72): compiled at issue time from the
   * control-plane policy so an active session never sees a silently remapped
   * projection target.
   */
  modelUniverse: ModelUniverseSnapshot;
  /**
   * #J2 contract A: the frozen profile-route binding (model roles/policy +
   * provider→pool execution target) captured at issue time. Profile-route
   * resolution uses this snapshot instead of the live policy, so a mid-session
   * control-plane edit never silently changes the model or execution target
   * of an active session — accounts/credentials/ECR stay live.
   */
  binding: SessionPolicySnapshot;
}>;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** In-memory child tokens bound to a live lease and profile. Activation never stores an account. */
export class LaunchSessionRegistry {
  private readonly sessions = new Map<string, LaunchSession>();

  public constructor(private readonly leaseActive: (leaseId: string) => boolean = () => true) {}

  public issue(input: Readonly<{ profileId: string; profileName: string; leaseId: string; modelUniverse: ModelUniverseSnapshot; binding: SessionPolicySnapshot }>): string {
    if (!this.leaseActive(input.leaseId)) throw new Error("lease-not-active");
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(tokenHash(token), {
      profileId: input.profileId,
      profileName: input.profileName,
      leaseId: input.leaseId,
      viewId: deriveClaudeViewId(input.profileId),
      modelUniverse: input.modelUniverse,
      binding: input.binding,
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
