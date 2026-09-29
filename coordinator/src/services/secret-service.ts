import type { Logger } from "pino";
import { assertValidSecretFormat, hashOrderPreimage } from "@oversync/sdk/secrets";
import type { OrderService } from "./order-service.js";

/**
 * Coordinates secret reveal between the two chains.
 *
 * The coordinator never holds funds, so revealing a secret to it cannot
 * cause loss of user funds — at worst the coordinator could withhold
 * the secret, in which case the user can retrieve it themselves
 * directly from the on-chain `OrderClaimed` event on whichever side
 * settled first.
 */
export class SecretService {
  constructor(
    private readonly orders: OrderService,
    private readonly log: Logger
  ) {}

  /**
  * Record a preimage revealed by a resolver or by the user. The
  * coordinator verifies it against every known on-chain order ID before
  * storing it, so a malicious caller cannot poison the cache.
   */
  async reveal(publicId: string, preimage: string, txHash: string): Promise<{ ok: true }> {
    assertValidSecretFormat(preimage, "preimage");
    const canonical = preimage.toLowerCase() as `0x${string}`;
    const order = await this.orders.get(publicId);
    if (!order) {
      throw new Error(`unknown order ${publicId}`);
    }
    const orderIds = [order.srcOrderId, order.dstOrderId].filter(
      (orderId): orderId is string => orderId !== null
    );
    const matchesKnownOrders = orderIds.length > 0 && orderIds.every((orderId) => {
      if (!/^\d+$/.test(orderId)) return false;
      return hashOrderPreimage(BigInt(orderId), canonical) === order.hashlock;
    });
    if (!matchesKnownOrders) {
      this.log.warn(
        { publicId, expected: order.hashlock, orderIds },
        "rejected preimage with mismatching hash"
      );
      throw new Error("preimage does not match order hashlock");
    }

    const existing = await this.orders.findByPreimage(canonical);
    if (existing && existing.publicId !== publicId) {
      this.log.warn(
        { publicId, reusedBy: existing.publicId },
        "rejected reused preimage"
      );
      throw new Error("preimage already used in another order");
    }

    await this.orders.recordSecret(publicId, canonical, txHash);
    return { ok: true };
  }

  /**
   * Look up a previously revealed preimage. Returns null if not
   * revealed yet.
   */
  async get(publicId: string): Promise<string | null> {
    const order = await this.orders.get(publicId);
    return order?.preimage ?? null;
  }
}
