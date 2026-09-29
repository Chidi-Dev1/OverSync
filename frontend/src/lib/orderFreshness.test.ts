import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isOrderStale, checkOrderFreshness } from './orderFreshness';
import type { RecoveredOrder } from './orderRecovery';

describe('orderFreshness', () => {
  const baseOrder: RecoveredOrder = {
    id: 'test-order-1',
    direction: 'eth_to_xlm',
    status: 'src_locked',
    hashlock: '0x123',
    src: {
      chain: 'ethereum',
      address: '0x111',
      asset: 'ETH',
      amount: '1000',
      timelock: Math.floor(Date.now() / 1000) + 3600, // 1 hour in future
    },
    dst: {
      chain: 'stellar',
      address: 'G222',
      asset: 'XLM',
      amount: '10000',
    },
    createdAt: Date.now() - 60000,
    updatedAt: Date.now() - 30000,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('isOrderStale', () => {
    it('returns false for null or undefined order', () => {
      expect(isOrderStale(null)).toBe(false);
      expect(isOrderStale(undefined)).toBe(false);
    });

    it('returns false for active order with future timelock', () => {
      expect(isOrderStale(baseOrder)).toBe(false);
    });

    it('returns true when isStale is explicitly set', () => {
      expect(isOrderStale({ ...baseOrder, isStale: true })).toBe(true);
      expect(isOrderStale({ ...baseOrder, stale: true } as any)).toBe(true);
    });

    it('returns true when coordinator order status is expired', () => {
      expect(isOrderStale({ ...baseOrder, status: 'expired' })).toBe(true);
    });

    it('returns true when coordinator order status is failed', () => {
      expect(isOrderStale({ ...baseOrder, status: 'failed' })).toBe(true);
    });

    it('returns true when src timelock has passed for non-completed order', () => {
      const pastOrder: RecoveredOrder = {
        ...baseOrder,
        src: {
          ...baseOrder.src,
          timelock: Math.floor(Date.now() / 1000) - 10, // 10s in past
        },
      };
      expect(isOrderStale(pastOrder)).toBe(true);
    });

    it('returns true when dst timelock has passed for non-completed order', () => {
      const pastOrder: RecoveredOrder = {
        ...baseOrder,
        dst: {
          ...baseOrder.dst,
          timelock: Math.floor(Date.now() / 1000) - 5,
        },
      };
      expect(isOrderStale(pastOrder)).toBe(true);
    });

    it('returns false when timelock has passed but order is completed', () => {
      const completedOrder: RecoveredOrder = {
        ...baseOrder,
        status: 'completed',
        src: {
          ...baseOrder.src,
          timelock: Math.floor(Date.now() / 1000) - 100,
        },
      };
      expect(isOrderStale(completedOrder)).toBe(false);
    });

    it('returns true when maxAgeMs is exceeded', () => {
      const now = Date.now();
      const oldOrder: RecoveredOrder = {
        ...baseOrder,
        updatedAt: now - 120_000,
      };
      expect(isOrderStale(oldOrder, { now, maxAgeMs: 60_000 })).toBe(true);
      expect(isOrderStale(oldOrder, { now, maxAgeMs: 180_000 })).toBe(false);
    });
  });

  describe('checkOrderFreshness', () => {
    it('returns fresh order and isStale boolean from coordinator response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => baseOrder,
      } as Response);

      const result = await checkOrderFreshness('test-order-1', {
        baseUrl: 'https://api.test',
      });

      expect(result.order).toEqual(baseOrder);
      expect(result.isStale).toBe(false);
    });

    it('detects staleness when coordinator returns expired order', async () => {
      const expiredOrder = { ...baseOrder, status: 'expired' as const };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => expiredOrder,
      } as Response);

      const result = await checkOrderFreshness('test-order-1', {
        baseUrl: 'https://api.test',
      });

      expect(result.order.status).toBe('expired');
      expect(result.isStale).toBe(true);
    });

    it('throws error when coordinator returns 404 or fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      await expect(
        checkOrderFreshness('missing-order', { baseUrl: 'https://api.test' })
      ).rejects.toThrow(/not found/);
    });
  });
});
