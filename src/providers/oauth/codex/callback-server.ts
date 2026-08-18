import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { OAuthFlowError } from "../../../credentials/errors.js";
import { CODEX_OAUTH_CALLBACK_PORT, CODEX_OAUTH_REDIRECT_URI } from "./protocol.js";

export type OAuthCallback = Readonly<{
  code: string;
  state: string;
}>;

export type OAuthCallbackServer = Readonly<{
  redirectUri: string;
  close: () => Promise<void>;
}>;

export async function listenOauthCallback(
  onCallback: (callback: OAuthCallback) => Promise<void>,
  options: Readonly<{ host?: "127.0.0.1"; port?: number }> = {},
): Promise<OAuthCallbackServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? CODEX_OAUTH_CALLBACK_PORT;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleCallbackRequest(req.url, res, onCallback);
  });
  try {
    await listenExclusive(server, host, port);
  } catch (error: unknown) {
    server.close();
    if (isAddressInUse(error)) throw new OAuthFlowError("callback-collision", "oauth callback port is occupied", 409);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new OAuthFlowError("callback-collision", "oauth callback bind failed", 409);
  }
  const redirectUri = port === CODEX_OAUTH_CALLBACK_PORT && address.port === CODEX_OAUTH_CALLBACK_PORT
    ? CODEX_OAUTH_REDIRECT_URI
    : `http://${host}:${String(address.port)}/callback`;
  return {
    redirectUri,
    close: () => new Promise((resolve, reject) => {
      server.close((closeError) => closeError ? reject(closeError) : resolve());
    }),
  };
}

async function handleCallbackRequest(
  url: string | undefined,
  res: ServerResponse,
  onCallback: (callback: OAuthCallback) => Promise<void>,
): Promise<void> {
  try {
    const parsed = new URL(url ?? "/", "http://127.0.0.1");
    if (parsed.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (!code || !state) {
      res.writeHead(400, { "content-type": "text/plain" }).end("invalid callback");
      return;
    }
    await onCallback({ code, state });
    if (!res.writableEnded) res.writeHead(200, { "content-type": "text/plain" }).end("authorization complete");
  } catch {
    if (!res.writableEnded) res.writeHead(400, { "content-type": "text/plain" }).end("authorization failed");
  }
}

function listenExclusive(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}
