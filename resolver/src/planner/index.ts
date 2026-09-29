/**
 * Resolver planner.
 *
 * The planner turns a canonical coordinator order into a
 * {@link ResolverPlan} — the exact parameters the resolver would submit
 * on-chain. It deliberately keeps building and validating separate:
 *
 *   1. `buildPlan(order)` snapshots the local view into a plan.
 *   2. `validatePlan(plan, order)` can be run at any time to detect
 *      drift.
 *   3. `submitValidatedPlan(plan, order, submit)` re-validates at the
 *      submit boundary so a plan that expired (or drifted) between
 *      build and submit is never handed to the Ethereum or Soroban
 *      listener.
 *
 * See `validate.ts` for the stable error codes.
 */

import {
  type PlanAction,
  type PlanLeg,
  type ResolverOrder,
  type ResolverPlan
} from "./validate.js";

export * from "./validate.js";

export interface BuildPlanOptions {
  /** Defaults to `"fill"` (lock the destination leg). */
  action?: PlanAction;
  /** Inject the build time; defaults to wall clock. */
  now?: number;
  /**
   * Override the plan deadline. Defaults to the earlier of the two leg
   * timelocks — the resolver must settle before either window closes.
   */
  expiresAt?: number;
}

function copyLeg(leg: PlanLeg): PlanLeg {
  return { ...leg };
}

/**
 * Build a plan for `order` from the resolver's local view.
 *
 * The returned plan is a snapshot: it never aliases the order's legs,
 * so later mutation of the order object cannot silently change a plan
 * that has already been validated.
 */
export function buildPlan(order: ResolverOrder, options: BuildPlanOptions = {}): ResolverPlan {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = options.expiresAt ?? Math.min(order.src.timelock, order.dst.timelock);
  return {
    publicId: order.publicId,
    action: options.action ?? "fill",
    hashlock: order.hashlock,
    src: copyLeg(order.src),
    dst: copyLeg(order.dst),
    expiresAt,
    builtAt: now
  };
}
