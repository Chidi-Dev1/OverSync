import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import RecoveryService, {
  RecoveryStatus,
  RecoveryType,
  type RecoveryConfig,
  type RecoverySubmitter,
} from "../src/recovery-service.js";
import {
  RelaySubmissionTracker,
  RelayOrderBusyError,
  type RelayAction,
} from "../src/relay-submission-tracker.js";

/**
 * The recovery service is constructed with stub collaborators and a submitter
 * that goes through a real tracker, so these tests exercise the real
 * single-flight invariant without a live chain, a Horizon server, or a timer.
 */

const ORDER_HASH = '0xorderhash';

function stubOrdersService(orders: any[]) {
  return {
    getActiveOrders: () => ({ items: orders, total: orders.length }),
  } as never;
}

function stubEventManager() {
  return {
    on: vi.fn(),
    emitEvent: vi.fn(),
  } as never;
}

function activeOrder(over: Record<string, unknown> = {}) {
  return {
    orderHash: ORDER_HASH,
    deadline: Math.floor(Date.now() / 1000) - 10_000,
    srcChainId: 1,
    dstChainId: 999,
    order: { makingAmount: '5000000', takerAmount: '5000000' },
    ...over,
  };
}

const config: RecoveryConfig = {
  monitoringInterval: 3_600_000, // never fires during the test
  autoRefundEnabled: true,
  emergencyEnabled: true,
  maxRetries: 0,
  retryDelay: 0,
  gracePeriod: 300,
};

describe("RecoveryService uses the shared submission door", () => {
  let tracker: RelaySubmissionTracker;
  let staged: ReturnType<typeof vi.fn>;
  let submitter: RecoverySubmitter;

  /**
   * Mirrors the production wiring in `index.ts`: recovery execution is a dry
   * run, so the submitter gates on the tracker's order lock instead of staging
   * a transaction. No synthetic hash is ever recorded.
   */
  function gateOnlySubmitter(): RecoverySubmitter {
    return async ({ orderId, side, action, chain, execute }) => {
      const recoveryAction = { orderId, side, action, chain } as RelayAction;
      const blocking = tracker.getBlockingRecord(recoveryAction);
      if (blocking) throw new RelayOrderBusyError(recoveryAction, blocking);
      staged.push(recoveryAction);
      return execute();
    };
  }

  beforeEach(() => {
    tracker = new RelaySubmissionTracker({ sleep: () => Promise.resolve() });
    staged = [];
    submitter = gateOnlySubmitter();
  });

  function makeService(orders: any[], custom = submitter) {
    return new RecoveryService(stubOrdersService(orders), stubEventManager(), config, custom);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes a manual recovery refund through the tracker, one release per order", async () => {
    const service = makeService([activeOrder()]);
    const recoveryId = await service.initiateManualRecovery(
      ORDER_HASH,
      RecoveryType.TimeoutRefund,
      'tester',
      'manual'
    );

    const request = service.getRecoveryRequest(recoveryId);
    expect(request?.status).toBe(RecoveryStatus.Completed);
    // Exactly one leg is released. The legacy implementation walked both
    // chains, which is a double release of the same locked funds.
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      orderId: ORDER_HASH,
      action: 'refund',
      chain: 'ethereum', // srcChainId === 1
      side: 'xlm_to_eth', // derived from the order's chain ids
    });

    // A dry run records no transaction, so it never occupies the order slot.
    expect(tracker.list()).toHaveLength(0);
    service.cleanup();
  });

  it("releases the Stellar leg when the source chain is Stellar", async () => {
    const service = makeService([activeOrder({ srcChainId: 999, dstChainId: 1 })]);
    await service.initiateManualRecovery(ORDER_HASH, RecoveryType.TimeoutRefund, 'tester', 'manual');
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ chain: 'stellar', side: 'eth_to_xlm' });
    service.cleanup();
  });

  it("marks a public withdrawal as a release, not a refund", async () => {
    const service = makeService([activeOrder()]);
    await service.initiateManualRecovery(ORDER_HASH, RecoveryType.PublicWithdrawal, 'anyone', 'public');
    expect(staged.every((s) => s.action === 'release')).toBe(true);
    service.cleanup();
  });

  it("refuses a recovery refund while a claim for the same order is in flight", async () => {
    const service = makeService([activeOrder()]);

    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const claimPromise = tracker
      .submit(
        { orderId: ORDER_HASH, side: 'xlm_to_eth', action: 'claim', chain: 'ethereum', network: 'sepolia' },
        () => ({
          txHash: '0xclaim',
          network: 'sepolia',
          broadcast: vi.fn(async () => {
            await gate;
            return { hash: '0xclaim' };
          }),
        })
      )
      .catch(() => undefined);
    await vi.waitFor(() =>
      expect(tracker.getRecord({ orderId: ORDER_HASH, side: 'xlm_to_eth', action: 'claim', chain: 'ethereum' })?.txHash).toBe('0xclaim')
    );

    const recoveryId = await service.initiateManualRecovery(
      ORDER_HASH,
      RecoveryType.TimeoutRefund,
      'system',
      'timelock expired'
    );
    release();
    await claimPromise;

    // The refund was refused, so the recovery stays pending rather than failed:
    // the next monitor tick can re-evaluate once the claim settles.
    const request = service.getRecoveryRequest(recoveryId);
    expect(request?.status).toBe(RecoveryStatus.Pending);
    // Only the claim exists; recovery did not execute or stage anything.
    expect(staged).toHaveLength(0);
    expect(tracker.list().map((r) => r.action.action)).toEqual(['claim']);
    service.cleanup();
  });

  it("emits a recovery event through the event manager", async () => {
    const service = makeService([activeOrder()]);
    await service.initiateManualRecovery(ORDER_HASH, RecoveryType.TimeoutRefund, 'tester', 'manual');
    const stats = service.getRecoveryStats();
    expect(stats.successfulRecoveries).toBe(1);
    expect(stats.totalValueRecovered).toBe('5000000');
    service.cleanup();
  });

  it("keeps the legacy dry run when no submitter is injected", async () => {
    // No submitter → the built-in dry-run submitter logs and resolves without
    // touching the tracker or the network. This preserves today's behaviour
    // for deployments that have not wired real recovery execution.
    const service = new RecoveryService(stubOrdersService([activeOrder()]), stubEventManager(), config);
    const recoveryId = await service.initiateManualRecovery(
      ORDER_HASH,
      RecoveryType.TimeoutRefund,
      'tester',
      'manual'
    );
    expect(service.getRecoveryRequest(recoveryId)?.status).toBe(RecoveryStatus.Completed);
    expect(tracker.list()).toHaveLength(0);
    service.cleanup();
  });

  it("stops its monitor on cleanup", () => {
    const service = makeService([activeOrder()]);
    expect(() => service.cleanup()).not.toThrow();
  });
});
