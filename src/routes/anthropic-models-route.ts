import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneStore } from "../control-plane/store.js";
import type { LaunchSession, LaunchSessionRegistry } from "../profiles/sessions.js";
import type { RegistryDocument } from "../registry/model-registry.js";
import {
  compileModelUniverseSnapshot,
  projectModelUniverse,
} from "../routing/model-projection/project.js";
import type { ModelProjection, ModelUniverseSnapshot } from "../routing/model-projection/types.js";

/**
 * Authenticated `GET /v1/models` gateway discovery surface (#72) on the
 * existing gateway listener (never the management listener). Uses the same
 * launch/gateway inference credentials Claude Code sends (instance bearer or
 * launch-session child token), matching the Anthropic Messages discovery wire
 * shape: `{ data: [{ type: "model", id, display_name, created_at }], has_more,
 * first_id, last_id }` with `limit` / `before_id` / `after_id` pagination.
 *
 * A launch-session token serves the session's pinned model universe; an
 * instance token serves the universe derived from the current control-plane
 * policy. Responses contain only trusted, configured models — never
 * credentials, account identity, prompts, or responses.
 */

const modelsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before_id: z.string().min(1).optional(),
  after_id: z.string().min(1).optional(),
});

export type AnthropicModelsRouteDependencies = Readonly<{
  controlPlane: ControlPlaneStore;
  sessions: LaunchSessionRegistry;
  registry: RegistryDocument;
  /** Explicit user policy opt-in exposing EXPERIMENTAL compatibility targets. */
  experimentalModels: boolean;
  resolveSession: (token: string | undefined) => LaunchSession | undefined;
  extractToken: (headers: Readonly<{ authorization?: string | undefined; "x-api-key"?: string | string[] | undefined }>) => string | undefined;
}>;

/** Deterministic `created_at` for a projection (registry evidence date, stable). */
export function projectionCreatedAt(projection: ModelProjection): string {
  const parsed = new Date(projection.verifiedAt);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

export function registerAnthropicModelsRoute(app: FastifyInstance, dependencies: AnthropicModelsRouteDependencies): void {
  app.get("/v1/models", async (request, reply) => {
    const parsedQuery = modelsQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({ type: "error", error: { type: "invalid_request_error", message: "Invalid models query" } });
    }
    const token = dependencies.extractToken(request.headers);
    const session = dependencies.resolveSession(token);
    const policy = dependencies.controlPlane.currentPolicy();
    if (policy === undefined) {
      return reply.code(503).send({ type: "error", error: { type: "models_unavailable", message: "No control-plane policy is available" } });
    }
    // Session tokens serve the pinned universe; instance tokens serve the
    // universe derived from the current policy (deterministic for a revision).
    const universe: ModelUniverseSnapshot = session?.modelUniverse
      ?? compileModelUniverseSnapshot(policy, dependencies.registry, {
        experimentalModels: dependencies.experimentalModels,
      });
    const projections = projectModelUniverse(dependencies.registry, universe);
    const { limit = 20, before_id, after_id } = parsedQuery.data;
    let window = projections;
    if (after_id !== undefined) {
      window = window.filter((projection) => projection.id > after_id);
    }
    if (before_id !== undefined) {
      window = window.filter((projection) => projection.id < before_id);
    }
    const page = window.slice(0, limit);
    return {
      data: page.map((projection) => ({
        type: "model",
        id: projection.id,
        display_name: projection.displayName,
        created_at: projectionCreatedAt(projection),
      })),
      has_more: window.length > limit,
      first_id: page[0]?.id ?? null,
      last_id: page.at(-1)?.id ?? null,
    };
  });
}
