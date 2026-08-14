export class ControlPlaneError extends Error {
  override name = "ControlPlaneError";
  public constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export class VersionConflictError extends ControlPlaneError {
  override name = "VersionConflictError";
  public constructor(resource = "resource") {
    super(`Stale ${resource} version`, 409, "stale-version");
  }
}

export class NotFoundError extends ControlPlaneError {
  override name = "NotFoundError";
  public constructor(resource = "resource") {
    super(`${resource} was not found`, 404, "not-found");
  }
}

export class ValidationError extends ControlPlaneError {
  override name = "ValidationError";
  public constructor(message: string) {
    super(message, 400, "invalid");
  }
}

export class UniquenessError extends ControlPlaneError {
  override name = "UniquenessError";
  public constructor(message: string) {
    super(message, 409, "conflict");
  }
}

export function isControlPlaneError(error: unknown): error is ControlPlaneError {
  return error instanceof ControlPlaneError;
}
