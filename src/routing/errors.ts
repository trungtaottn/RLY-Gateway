export class RoutingError extends Error {
  override name = "RoutingError";
  public constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class NoEligibleAccountError extends RoutingError {
  override name = "NoEligibleAccountError";
  public constructor(readonly requestId: string) {
    super("No eligible account for the requested route", "no-eligible-account");
  }
}

export class StaleRouteBindingError extends RoutingError {
  override name = "StaleRouteBindingError";
  public constructor(message = "Route binding is no longer valid") {
    super(message, "stale-route-binding");
  }
}

export class RouteSealedError extends RoutingError {
  override name = "RouteSealedError";
  public constructor() {
    super("Account rotation is blocked after the first output or tool event", "route-sealed");
  }
}

export function isRoutingError(error: unknown): error is RoutingError {
  return error instanceof RoutingError;
}
