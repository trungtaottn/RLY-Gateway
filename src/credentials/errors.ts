export class CredentialError extends Error {
  override name = "CredentialError";
  public constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export class ImportIncompatibleError extends CredentialError {
  override name = "ImportIncompatibleError";
  public constructor(message = "credential source is incompatible") {
    super(message, 400, "import-incompatible");
  }
}

export class StaleGenerationError extends CredentialError {
  override name = "StaleGenerationError";
  public constructor() {
    super("stale credential generation", 409, "stale-generation");
  }
}

export class CredentialUnreadyError extends CredentialError {
  override name = "CredentialUnreadyError";
  public constructor(message = "credential is unready") {
    super(message, 409, "credential-unready");
  }
}

export class OAuthFlowError extends CredentialError {
  override name = "OAuthFlowError";
  public constructor(code: string, message: string, statusCode = 400) {
    super(message, statusCode, code);
  }
}

export function isCredentialError(error: unknown): error is CredentialError {
  return error instanceof CredentialError;
}
