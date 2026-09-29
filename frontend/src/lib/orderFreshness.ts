import { fetchOrderById, type RecoveredOrder } from './orderRecovery';

export interface OrderFreshnessOptions {
  now?: number;
  maxAgeMs?: number;
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * Checks whether an order is stale.
 *
 * An order is considered stale if:
 * 1. It explicitly carries `isStale = true` or `stale = true`.
 * 2. The coordinator has marked its status as 'expired'.
 * 3. The coordinator has marked its status as 'failed'.
 * 4. Its timelock has passed and the order has not reached terminal 'completed'.
 * 5. It has exceeded maxAgeMs without being updated.
 */
export function isOrderStale(
  order: RecoveredOrder | null | undefined,
  options?: OrderFreshnessOptions
): boolean {
  if (!order) return false;

  // Explicit staleness flag
  if (order.isStale === true || (order as any).stale === true) {
    return true;
  }

  // Soft/terminal expired status from coordinator
  if (order.status === 'expired') {
    return true;
  }

  // Failed state is also stale/unactionable
  if (order.status === 'failed') {
    return true;
  }

  const now = options?.now ?? Date.now();

  // Check timelock expiration on source or destination leg
  const srcTimelock = order.src?.timelock;
  if (srcTimelock && srcTimelock > 0) {
    const srcTimelockMs = srcTimelock > 1e11 ? srcTimelock : srcTimelock * 1000;
    if (now >= srcTimelockMs && order.status !== 'completed') {
      return true;
    }
  }

  const dstTimelock = order.dst?.timelock;
  if (dstTimelock && dstTimelock > 0) {
    const dstTimelockMs = dstTimelock > 1e11 ? dstTimelock : dstTimelock * 1000;
    if (now >= dstTimelockMs && order.status !== 'completed') {
      return true;
    }
  }

  // Check optional age limit if provided
  if (options?.maxAgeMs && order.updatedAt) {
    const updatedAtMs = order.updatedAt > 1e11 ? order.updatedAt : order.updatedAt * 1000;
    if (now - updatedAtMs > options.maxAgeMs) {
      return true;
    }
  }

  return false;
}

/**
 * Verifies freshness of an order by polling the coordinator API.
 * Returns the fresh order and whether it is stale.
 * If the request fails, the caller can catch the error, keep the restored order
 * visible, and provide an explicit retry trigger.
 */
export async function checkOrderFreshness(
  orderId: string,
  options?: OrderFreshnessOptions
): Promise<{ order: RecoveredOrder; isStale: boolean }> {
  const order = await fetchOrderById(orderId, {
    baseUrl: options?.baseUrl,
    signal: options?.signal,
  });

  if (!order) {
    throw new Error(`Order ${orderId} was not found on the coordinator.`);
  }

  const isStale = isOrderStale(order, options);
  return { order, isStale };
}
