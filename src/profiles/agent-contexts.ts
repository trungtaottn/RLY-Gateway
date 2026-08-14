import type { LogicalTier } from "../routing/model-tiers/types.js";
import type { LaunchSession } from "./sessions.js";

/**
 * Session-scoped Claude Code execution-context registry (#71).
 *
 * Associates a Claude Code session/agent identifier with the resolved
 * execution context needed by #69 tier resolution: launch/profile binding,
 * access provider, resolved physical model id, model family, effective tier
 * (when applicable), and the mapping/registry revisions used for resolution.
 *
 * Rules:
 * - Runtime-only and in-memory (no durable requirement exists; contexts
 *   disappear on runtime restart).
 * - Bound to the existing launch session/lease: entries are only valid while
 *   their owning lease is active, and `dropLease` removes them when the lease
 *   is revoked — stale ephemeral agent ids never bind a future session.
 * - Never stores credentials, account ids, or account identity.
 * - Each context is recorded AFTER a request resolves (physical model frozen);
 *   failed activations record nothing.
 */

export type ExecutionContextRole = "main" | "subagent";

export type ExecutionContext = Readonly<{
  claudeSessionId: string;
  agentId: string;
  parentAgentId?: string;
  role: ExecutionContextRole;
  /** Owning launch session binding; used for lease-scoped validity. */
  leaseId: string;
  profileId: string;
  profileName: string;
  /** Trusted registry access provider id the model was resolved under. */
  accessProviderId: string;
  /** Frozen physical model id resolved for this agent's last request. */
  resolvedModelId: string;
  modelFamily?: string;
  /** Effective tier when the last request was a logical tier request (#69). */
  effectiveTier?: LogicalTier;
  mappingRevision?: number;
  registryRevision?: number;
  updatedAt: string;
}>;

/** How the parent/current execution context was derived for a request. */
export type ParentContextSource = "parent-agent" | "session-default" | "profile-default";

export type ParentExecutionReference = Readonly<{
  context: ExecutionContext;
  source: ParentContextSource;
}>;

function sessionKey(session: LaunchSession, claudeSessionId: string, agentId: string): string {
  return `${session.leaseId}|${claudeSessionId}|${agentId}`;
}

/**
 * In-memory, lease-scoped agent execution contexts. Mirrors the
 * `LaunchSessionRegistry` security boundary: a token/session is only valid
 * while its lease is active, and dropped leases remove all entries.
 */
export class AgentExecutionContextRegistry {
  private readonly contexts = new Map<string, ExecutionContext>();

  public constructor(private readonly leaseActive: (leaseId: string) => boolean = () => true) {}

  public record(session: LaunchSession, context: Readonly<Omit<ExecutionContext, "leaseId" | "profileId" | "profileName">>): void {
    if (context.agentId === "" || context.claudeSessionId === "") return;
    if (!this.leaseActive(session.leaseId)) return;
    this.contexts.set(sessionKey(session, context.claudeSessionId, context.agentId), Object.freeze({
      ...context,
      leaseId: session.leaseId,
      profileId: session.profileId,
      profileName: session.profileName,
    }));
  }

  /** Exact parent-agent context for one session, valid only while the lease is active. */
  public resolve(session: LaunchSession, claudeSessionId: string, agentId: string): ExecutionContext | undefined {
    return this.valid(sessionKey(session, claudeSessionId, agentId));
  }

  /** The session's main-agent context (agent with no parent), if recorded. */
  public mainContext(session: LaunchSession, claudeSessionId: string): ExecutionContext | undefined {
    return this.contextsForSession(session, claudeSessionId).find((context) => context.role === "main");
  }

  /** All contexts recorded for one Claude session, in insertion order. */
  public contextsForSession(session: LaunchSession, claudeSessionId: string): readonly ExecutionContext[] {
    const prefix = `${session.leaseId}|${claudeSessionId}|`;
    const entries: ExecutionContext[] = [];
    for (const [key, context] of this.contexts) {
      if (!key.startsWith(prefix)) continue;
      if (!this.leaseActive(context.leaseId)) {
        this.contexts.delete(key);
        continue;
      }
      entries.push(context);
    }
    return entries;
  }

  /** Removes every context bound to a lease (lease/session revocation). */
  public dropLease(leaseId: string): void {
    for (const [key, context] of this.contexts) {
      if (context.leaseId === leaseId) this.contexts.delete(key);
    }
  }

  public size(): number {
    return this.contexts.size;
  }

  private valid(key: string): ExecutionContext | undefined {
    const context = this.contexts.get(key);
    if (context === undefined) return undefined;
    if (this.leaseActive(context.leaseId)) return context;
    this.contexts.delete(key);
    return undefined;
  }
}
