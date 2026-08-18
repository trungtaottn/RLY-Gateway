import { describe, expect, it, vi } from "vitest";
import { LeaseManager } from "../../src/runtime/lease-manager.js";

describe("lease manager", () => {
  it("notifies onExpire when a lease TTL elapses", async () => {
    vi.useFakeTimers();
    try {
      const expired: string[] = [];
      const leases = new LeaseManager({
        ttlMs: 10,
        idleGraceMs: 50,
        onIdle: () => undefined,
        onExpire: (leaseId) => { expired.push(leaseId); },
      });
      await leases.add("00000000-0000-4000-8000-000000000011");
      await vi.advanceTimersByTimeAsync(11);
      expect(expired).toEqual(["00000000-0000-4000-8000-000000000011"]);
      expect(leases.has("00000000-0000-4000-8000-000000000011")).toBe(false);
      leases.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a crashed launcher and shuts down after idle grace", async () => {
    vi.useFakeTimers();
    try {
      const idle = vi.fn();
      const leases = new LeaseManager({ ttlMs: 15, idleGraceMs: 2, onIdle: idle });
      await leases.add("00000000-0000-4000-8000-000000000011");
      await vi.advanceTimersByTimeAsync(14);
      expect(idle).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3);
      expect(idle).toHaveBeenCalledOnce();
      leases.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels idle shutdown when a new launcher arrives", async () => {
    vi.useFakeTimers();
    try {
      const idle = vi.fn();
      const leases = new LeaseManager({ ttlMs: 100, idleGraceMs: 10, onIdle: idle });
      const first = "00000000-0000-4000-8000-000000000011";
      await leases.add(first);
      await leases.release(first);
      await vi.advanceTimersByTimeAsync(5);
      await leases.add("00000000-0000-4000-8000-000000000012");
      await vi.advanceTimersByTimeAsync(10);
      expect(idle).not.toHaveBeenCalled();
      leases.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a lease once idle shutdown has begun", async () => {
    vi.useFakeTimers();
    try {
      let continueShutdown: (() => void) | undefined;
      const idle = vi.fn(async (stillIdle: () => boolean) => {
        expect(stillIdle()).toBe(true);
        await new Promise<void>((resolve) => { continueShutdown = resolve; });
      });
      const leases = new LeaseManager({ ttlMs: 100, idleGraceMs: 10, onIdle: idle });
      const first = "00000000-0000-4000-8000-000000000011";
      await leases.add(first);
      await leases.release(first);
      await vi.advanceTimersByTimeAsync(10);
      expect(idle).toHaveBeenCalledOnce();
      await expect(leases.add("00000000-0000-4000-8000-000000000012"))
        .rejects.toThrow("stopping");
      continueShutdown?.();
      await vi.runAllTimersAsync();
      leases.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  // #J8: the 15s lease TTL vs 5s launcher heartbeat is aggressive for desktop
  // coding workflows — a single stalled heartbeat (laptop suspend, event-loop
  // stall) longer than the TTL expires the launch session permanently. These
  // deterministic tests encode the black-box finding (no heartbeat → 401 at
  // t+15s; heartbeat renews keep the session alive).
  it("soak: renews across many TTL windows keep the lease alive (normal use)", async () => {
    vi.useFakeTimers();
    try {
      const expired: string[] = [];
      const leases = new LeaseManager({ ttlMs: 15, idleGraceMs: 50, onIdle: () => undefined, onExpire: (id) => { expired.push(id); } });
      await leases.add("00000000-0000-4000-8000-000000000011");
      // Simulate a long-running Claude session: heartbeat every 5s (HEARTBEAT_MS)
      // against a 15s TTL for ~10 minutes. The lease must never expire.
      for (let tick = 0; tick < 120; tick += 1) {
        await vi.advanceTimersByTimeAsync(5);
        await leases.renew("00000000-0000-4000-8000-000000000011");
      }
      expect(expired).toEqual([]);
      expect(leases.has("00000000-0000-4000-8000-000000000011")).toBe(true);
      leases.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suspend/resume: a gap longer than the TTL expires the lease and renew cannot recover it", async () => {
    vi.useFakeTimers();
    try {
      const expired: string[] = [];
      const leases = new LeaseManager({ ttlMs: 15, idleGraceMs: 50, onIdle: () => undefined, onExpire: (id) => { expired.push(id); } });
      await leases.add("00000000-0000-4000-8000-000000000011");
      // One heartbeat, then the machine suspends: no heartbeat for 16s (> TTL).
      await vi.advanceTimersByTimeAsync(5);
      await leases.renew("00000000-0000-4000-8000-000000000011");
      await vi.advanceTimersByTimeAsync(16);
      expect(expired).toEqual(["00000000-0000-4000-8000-000000000011"]);
      expect(leases.has("00000000-0000-4000-8000-000000000011")).toBe(false);
      // On resume the launcher heartbeat calls renew — the lease is gone and
      // renew throws ("Lease is not active"); the launcher's .catch swallows it,
      // so the session stays revoked and the user must restart Claude Code.
      await expect(leases.renew("00000000-0000-4000-8000-000000000011")).rejects.toThrow(/not active/);
      leases.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
