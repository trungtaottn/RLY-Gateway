import type { CanonicalEvent } from "../../core/canonical-event.js";
import type { CanonicalRequest } from "../../core/canonical-request.js";
import { classifyProviderFailure, cooldownUntilFor, nextQuotaClass } from "../../control-plane/health/outcomes.js";
import type { RouteOutcomeClass } from "../../control-plane/health/types.js";
import type { ControlPlaneStore } from "../../control-plane/store.js";
import { parseAffinity } from "./affinity.js";
import type { EffectiveRoute } from "../effective-route.js";
import { markOutputStarted } from "../effective-route.js";
import { NoEligibleAccountError, RouteSealedError } from "../errors.js";
import type { DecisionTrace } from "../eligibility/trace.js";
import { canRotate, isAbortError, isOutputOrToolEvent } from "./retry.js";
import type { RouteSelector, SelectInput } from "./selector.js";

export type PoolInvoke = (
  route: EffectiveRoute,
  signal: AbortSignal,
) => AsyncIterable<CanonicalEvent> | Iterable<CanonicalEvent>;

export type PoolExecution = Readonly<{
  route: EffectiveRoute;
  traces: readonly DecisionTrace[];
  events: readonly CanonicalEvent[];
}>;

export type PoolRequestInput = Readonly<{
  selector: RouteSelector;
  store: ControlPlaneStore;
  request: CanonicalRequest;
  select: Omit<SelectInput, "requestId" | "excludeAccountIds">;
  invoke: PoolInvoke;
  signal: AbortSignal;
  onTrace?: (trace: DecisionTrace) => void;
}>;

export async function executePoolRequest(input: PoolRequestInput): Promise<PoolExecution> {
  const events: CanonicalEvent[] = [];
  const traces: DecisionTrace[] = [];
  let route: EffectiveRoute | undefined;
  for await (const event of streamPoolRequest({
    ...input,
    onTrace: (trace) => {
      traces.push(trace);
      input.onTrace?.(trace);
    },
    onRoute: (selected) => {
      route = selected;
    },
  })) {
    events.push(event);
  }
  if (!route) throw new NoEligibleAccountError(input.request.id);
  return { route, traces, events };
}

/** Yields events only after rotation is no longer possible, so helpers never see a discarded attempt. */
export async function* streamPoolRequest(input: PoolRequestInput & {
  onRoute?: (route: EffectiveRoute) => void;
}): AsyncIterable<CanonicalEvent> {
  const pool = input.select.policy.snapshot.pools.find((item) => item.id === input.select.poolId);
  const retryBudget = pool?.retryBudget ?? 0;
  const affinity = parseAffinity(pool?.affinity);
  const tried: string[] = [];
  let lastError: Error | undefined;

  attempt: for (let rotationsUsed = 0; rotationsUsed < retryBudget + 1; rotationsUsed += 1) {
    let selected;
    try {
      selected = await input.selector.select({
        ...input.select,
        requestId: input.request.id,
        excludeAccountIds: tried,
      });
    } catch (error) {
      if (error instanceof NoEligibleAccountError && lastError !== undefined) throw lastError;
      throw error;
    }
    input.onTrace?.(selected.trace);
    input.selector.revalidate(selected.route, input.select);
    const buffered: CanonicalEvent[] = [];
    let route = selected.route;
    let live = false;
    const flush = function* (): Generator<CanonicalEvent> {
      input.onRoute?.(route);
      yield* buffered;
    };
    try {
      for await (const event of input.invoke(route, input.signal)) {
        if (!route.outputStarted && isOutputOrToolEvent(event)) route = markOutputStarted(route);
        if (live) {
          yield event;
        } else {
          buffered.push(event);
          if (route.outputStarted) {
            live = true;
            yield* flush();
            buffered.length = 0;
          }
        }
        if (event.type !== "response-failed") continue;
        const outcome = classifyProviderFailure(event.code);
        recordOutcome(input.store, route, outcome, affinity.cooldownSeconds);
        lastError = new RouteFailure(outcome, event.code);
        if (canRotate({ outputStarted: route.outputStarted, rotationsUsed, retryBudget, outcome })) {
          tried.push(route.accountId);
          continue attempt;
        }
        throw route.outputStarted ? new RouteSealedError() : lastError;
      }
      recordOutcome(input.store, route, "success", affinity.cooldownSeconds);
      yield* flush();
      return;
    } catch (error) {
      if (error instanceof RouteSealedError || error instanceof RouteFailure) {
        yield* flush();
        throw error;
      }
      if (isAbortError(error)) throw error;
      const outcome = classifyThrown(error);
      recordOutcome(input.store, route, outcome, affinity.cooldownSeconds);
      lastError = error instanceof Error ? error : new Error("provider invoke failed");
      if (!canRotate({ outputStarted: route.outputStarted, rotationsUsed, retryBudget, outcome })) {
        yield* flush();
        throw lastError;
      }
      tried.push(route.accountId);
    }
  }
  throw lastError ?? new NoEligibleAccountError(input.request.id);
}

export class RouteFailure extends Error {
  override name = "RouteFailure";
  public constructor(
    readonly outcome: RouteOutcomeClass,
    readonly code: string,
  ) {
    super("Provider request failed");
  }
}

function recordOutcome(
  store: ControlPlaneStore,
  route: EffectiveRoute,
  outcome: RouteOutcomeClass,
  cooldownSeconds: Readonly<{ auth: number; quota: number; transient: number }>,
): void {
  const cooldown = outcome === "success" ? null : cooldownUntilFor(outcome, store.currentTime(), cooldownSeconds);
  const current = store.getAccount(route.accountId);
  store.recordRouteOutcome(route.accountId, {
    outcome,
    quotaClass: nextQuotaClass(outcome, current.quotaClass),
    cooldownUntil: cooldown ?? null,
  });
}

function classifyThrown(error: unknown): RouteOutcomeClass {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  return classifyProviderFailure(code);
}
