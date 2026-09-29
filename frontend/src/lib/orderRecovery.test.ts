import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getActiveOrderId,
  setActiveOrderId,
  clearActiveOrderId,
  getActiveOrder,
  setActiveOrder,
  clearActiveOrder,
  fetchOrderById,
  isResponseForCurrentOrder,
  OrderRecoveryTracker,
  type RecoveredOrder,
  ACTIVE_ORDER_ID_KEY,
  ACTIVE_ORDER_DATA_KEY,
} from './orderRecovery';

describe('orderRecovery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('Storage helpers', () => {
    it('manages active order id in localStorage', () => {
      expect(getActiveOrderId()).toBeNull();

      setActiveOrderId('order-123');
      expect(localStorage.getItem(ACTIVE_ORDER_ID_KEY)).toBe('order-123');
      expect(getActiveOrderId()).toBe('order-123');

      clearActiveOrderId();
      expect(getActiveOrderId()).toBeNull();
      expect(localStorage.getItem(ACTIVE_ORDER_ID_KEY)).toBeNull();
    });

    it('manages active order object in localStorage', () => {
      const mockOrder: RecoveredOrder = {
        id: 'order-abc',
        direction: 'eth_to_xlm',
        status: 'src_locked',
        hashlock: '0x123',
        src: {
          chain: 'ethereum',
          address: '0xUser',
          asset: 'ETH',
          amount: '1000000000000000000',
        },
        dst: {
          chain: 'stellar',
          address: 'GUser',
          asset: 'XLM',
          amount: '10000000000',
        },
        createdAt: 1000,
        updatedAt: 2000,
      };

      expect(getActiveOrder()).toBeNull();
      setActiveOrder(mockOrder);

      expect(localStorage.getItem(ACTIVE_ORDER_ID_KEY)).toBe('order-abc');
      expect(getActiveOrder()).toEqual(mockOrder);

      clearActiveOrder();
      expect(getActiveOrder()).toBeNull();
      expect(getActiveOrderId()).toBeNull();
    });
  });

  describe('fetchOrderById', () => {
    it('returns recovered order when API returns 200', async () => {
      const mockOrder: RecoveredOrder = {
        id: 'order-456',
        direction: 'eth_to_xlm',
        status: 'dst_locked',
        hashlock: '0xabc',
        src: {
          chain: 'ethereum',
          address: '0x111',
          asset: 'ETH',
          amount: '1',
        },
        dst: {
          chain: 'stellar',
          address: 'G222',
          asset: 'XLM',
          amount: '10000',
        },
        createdAt: 1000,
        updatedAt: 2000,
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockOrder,
      } as Response);

      const order = await fetchOrderById('order-456', { baseUrl: 'https://api.test' });
      expect(order).toEqual(mockOrder);
      expect(fetch).toHaveBeenCalledWith('https://api.test/api/orders/order-456', expect.any(Object));
    });

    it('returns null when API returns 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const order = await fetchOrderById('missing-order', { baseUrl: 'https://api.test' });
      expect(order).toBeNull();
    });

    it('throws error when API returns 500', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      await expect(
        fetchOrderById('broken-order', { baseUrl: 'https://api.test' })
      ).rejects.toThrow(/status 500/);
    });
  });

  describe('Late response detection and OrderRecoveryTracker', () => {
    it('isResponseForCurrentOrder correctly matches ids case-insensitively', () => {
      expect(isResponseForCurrentOrder('order-1', 'order-1')).toBe(true);
      expect(isResponseForCurrentOrder('ORDER-1', 'order-1')).toBe(true);
      expect(isResponseForCurrentOrder('order-1', 'order-2')).toBe(false);
      expect(isResponseForCurrentOrder(null, 'order-1')).toBe(false);
    });

    it('OrderRecoveryTracker rejects late responses from older sequences', () => {
      const tracker = new OrderRecoveryTracker();

      const seq1 = tracker.startRequest('order-1');
      expect(tracker.isCurrent('order-1', seq1)).toBe(true);

      const seq2 = tracker.startRequest('order-2');
      expect(tracker.isCurrent('order-2', seq2)).toBe(true);

      // Late response for order-1 arriving now must be rejected
      expect(tracker.isCurrent('order-1', seq1)).toBe(false);
      // Older sequence for same id if restarted is also rejected
      expect(tracker.isCurrent('order-2', seq1)).toBe(false);

      tracker.reset();
      expect(tracker.getCurrentId()).toBeNull();
      expect(tracker.isCurrent('order-2', seq2)).toBe(false);
    });
  });
});
