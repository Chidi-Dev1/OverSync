import { Address, Hash } from '../types';
import { ConfigService } from './config-service';

interface LockRequest {
  lockHash: Hash;
  target: Address;
  amount: bigint;
  expiration: number;
}

export class OrderService {
  private config: ConfigService;

  constructor(config: ConfigService) {
    this.config = config;
  }

  async buildLockOrder(request: LockRequest): Promise<any> {
    const activeV2Escrow = this.config.getActiveV2Escrow();

    if (activeV2Escrow && activeV2Escrow.toLowerCase() !== request.target.toLowerCase()) {
      throw new Error("Legacy bridge lock rejected: v2 escrow active");
    }

    const hashlock = input.hashlock.toLowerCase() as `0x${string}`;

    // --- Quote freshness gate -------------------------------------------
    if (input.quoteId) {
      if (!this.quoteService) {
        // No QuoteService wired in (e.g. test mode without quotes) — skip.
        this.log.debug({ quoteId: input.quoteId }, "quoteId supplied but no QuoteService wired; skipping freshness check");
      } else {
        try {
          this.quoteService.bindOrderTerms(input.quoteId, {
            fromAsset: input.srcAsset,
            toAsset: input.dstAsset,
            amount: input.srcAmount,
            fromNetwork: input.srcChain,
            toNetwork: input.dstChain
          });
          this.log.debug({ quoteId: input.quoteId }, "quote freshness confirmed");
        } catch (err) {
          if (err instanceof QuoteExpiredError || err instanceof QuoteNotFoundError) {
            throw new OrderValidationError(err.message);
          }
          throw err;
        }
      }
    }
    // -------------------------------------------------------------------

    const existing = await this.repo.findByHashlock(hashlock);
    if (existing) {
      throw new OrderValidationError(
        `An order with hashlock ${hashlock} already exists (publicId=${existing.publicId})`
      );
    }

    // Strip quoteId — it's not a persisted column, just a freshness gate.
    const { quoteId: _q, ...repoInput } = input;
    const order = await this.repo.announce({ ...repoInput, hashlock } as AnnounceOrderInput);
    this.log.info(
      { publicId: order.publicId, direction: order.direction, quoteId: input.quoteId ?? null },
      "order announced"
    );
    ordersTotal.inc({ status: "announced" });
    return order;
  }

  private async buildV2EscrowOrder(request: LockRequest): Promise<any> {
    // Implementation for v2 escrow order building
    return {
      type: 'v2_escrow_lock',
      ...request
    };
  }
}

export class LegacyLockError extends Error {
  constructor() {
    super("legacy lock refused");
    this.name = "LegacyLockError";
  }
}

/** Use the v2 escrow when it is configured. A legacy-bridge target builds nothing. */
export function resolveLockTarget(input: {
  v2Escrow?: string | null;
  requestedTarget: string;
  legacyBridge: string;
}): { target: string } {
  const v2 = (input.v2Escrow ?? "").trim();
  if (!v2) return { target: input.requestedTarget };
  if (input.requestedTarget.toLowerCase() === input.legacyBridge.toLowerCase()) {
    throw new LegacyLockError();
  }
  return { target: v2 };
}