import type { GatewayLeaseRegistry } from "./gateway-server.js";

export type LeaseManagerOptions = Readonly<{
  ttlMs: number;
  idleGraceMs: number;
  onIdle: (stillIdle: () => boolean) => Promise<void> | void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}>;

/** Owns expiring launcher leases and triggers shutdown only after an idle grace. */
export class LeaseManager implements GatewayLeaseRegistry {
  readonly #expiresAt = new Map<string, number>();
  readonly #options: LeaseManagerOptions;
  #timer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #idlePromise: Promise<void> | undefined;
  #generation = 0;
  #stopping = false;

  public constructor(options: LeaseManagerOptions) {
    this.#options = options;
  }

  public add(leaseId: string): Promise<void> {
    if (this.#stopping) return Promise.reject(new Error("Gateway is stopping"));
    this.#generation += 1;
    this.#cancelIdle();
    this.#expiresAt.set(leaseId, this.#now() + this.#options.ttlMs);
    this.#scheduleExpiry();
    return Promise.resolve();
  }

  public async renew(leaseId: string): Promise<void> {
    if (!this.#expiresAt.has(leaseId)) throw new Error("Lease is not active");
    await this.add(leaseId);
  }

  public release(leaseId: string): Promise<void> {
    this.#expiresAt.delete(leaseId);
    this.#scheduleExpiry();
    this.#scheduleIdleIfEmpty();
    return Promise.resolve();
  }

  public has(leaseId: string): boolean {
    return (this.#expiresAt.get(leaseId) ?? 0) > this.#now();
  }

  public async waitForIdle(): Promise<void> {
    this.#scheduleIdleIfEmpty();
    await (this.#idlePromise ?? Promise.resolve());
  }

  public dispose(): void {
    if (this.#timer) this.#clearTimer(this.#timer);
    if (this.#idleTimer) this.#clearTimer(this.#idleTimer);
    this.#timer = undefined;
    this.#idleTimer = undefined;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #setTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
    return (this.#options.setTimer ?? setTimeout)(callback, delayMs);
  }

  #clearTimer(timer: NodeJS.Timeout): void {
    (this.#options.clearTimer ?? clearTimeout)(timer);
  }

  #scheduleExpiry(): void {
    if (this.#timer) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    const next = Math.min(...this.#expiresAt.values());
    if (!Number.isFinite(next)) return;
    this.#timer = this.#setTimer(() => {
      const now = this.#now();
      for (const [leaseId, expiresAt] of this.#expiresAt) {
        if (expiresAt <= now) this.#expiresAt.delete(leaseId);
      }
      this.#scheduleExpiry();
      this.#scheduleIdleIfEmpty();
    }, Math.max(0, next - this.#now()));
  }

  #cancelIdle(): void {
    if (this.#idleTimer) this.#clearTimer(this.#idleTimer);
    this.#idleTimer = undefined;
    this.#idlePromise = undefined;
  }

  #scheduleIdleIfEmpty(): void {
    if (this.#expiresAt.size > 0 || this.#idleTimer) return;
    const generation = this.#generation;
    this.#idlePromise = new Promise((resolve) => {
      this.#idleTimer = this.#setTimer(() => {
        this.#idleTimer = undefined;
        const stillIdle = (): boolean => this.#expiresAt.size === 0 && this.#generation === generation;
        if (!stillIdle()) {
          resolve();
          return;
        }
        this.#stopping = true;
        void Promise.resolve(this.#options.onIdle(stillIdle)).finally(resolve);
      }, this.#options.idleGraceMs);
    });
  }
}
