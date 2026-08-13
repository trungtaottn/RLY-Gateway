export type ShutdownResult = Readonly<{
  completed: boolean;
}>;

export type ShutdownControllerOptions = Readonly<{
  timeoutMs: number;
  requestStop: () => void;
  forceStop?: () => void;
}>;

/** Coordinates one bounded shutdown request, even when several cancellation sources race. */
export class ShutdownController {
  private shutdownPromise: Promise<ShutdownResult> | undefined;

  public constructor(private readonly options: ShutdownControllerOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new Error("Shutdown timeout must be a non-negative finite number");
    }
  }

  public shutdown(completion: Promise<unknown>): Promise<ShutdownResult> {
    this.shutdownPromise ??= this.stopOnce(completion);
    return this.shutdownPromise;
  }

  private async stopOnce(completion: Promise<unknown>): Promise<ShutdownResult> {
    this.options.requestStop();
    const completed = await Promise.race([
      completion.then(() => true, () => true),
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), this.options.timeoutMs); }),
    ]);
    if (!completed) this.options.forceStop?.();
    return { completed };
  }
}
