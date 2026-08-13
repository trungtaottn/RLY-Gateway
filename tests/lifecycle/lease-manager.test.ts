import { describe, expect, it, vi } from "vitest";
import { LeaseManager } from "../../src/runtime/lease-manager.js";

describe("lease manager", () => {
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
});
