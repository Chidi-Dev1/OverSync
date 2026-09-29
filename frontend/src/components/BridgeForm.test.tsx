import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BridgeForm from './BridgeForm';
import { setActiveOrderId, type RecoveredOrder } from '../lib/orderRecovery';
import type { NetworkModeState } from '../lib/useNetworkMode';

vi.mock('../config/networks', () => ({
  isTestnet: vi.fn(() => true),
  isMainnetEnabled: vi.fn(() => true),
  getCurrentNetwork: vi.fn(() => ({
    ethereum: { chainId: '0xaa36a7', name: 'Sepolia', explorerUrl: 'https://sepolia.etherscan.io' },
    stellar: { networkPassphrase: 'Test SDF Network ; September 2015', horizonUrl: 'https://horizon-testnet.stellar.org', explorerUrl: 'https://stellar.expert' },
  })),
}));

const mockNetworkState: NetworkModeState = {
  mode: 'testnet',
  expectedEthChainIdHex: '0xaa36a7',
  expectedStellarPassphrase: 'Test SDF Network ; September 2015',
  metamaskChainId: '0xaa36a7',
  metamaskConnected: true,
  metamaskMatches: true,
  freighterNetworkPassphrase: 'Test SDF Network ; September 2015',
  freighterConnected: true,
  freighterMatches: true,
  hasAnyMismatch: false,
  setMode: vi.fn().mockResolvedValue({ ok: true }),
  syncWalletsToAppMode: vi.fn().mockResolvedValue({ ok: true }),
  refreshWalletNetworks: vi.fn(),
};

const sampleOrder: RecoveredOrder = {
  id: 'order-xyz-123',
  direction: 'eth_to_xlm',
  status: 'src_locked',
  hashlock: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  src: {
    chain: 'ethereum',
    address: '0x1111111111111111111111111111111111111111',
    asset: 'ETH',
    amount: '1.5',
    timelock: Math.floor(Date.now() / 1000) + 3600,
  },
  dst: {
    chain: 'stellar',
    address: 'GBBD6XCYNN45DA7CQ74TGMSW7CQJ2N4S7R4X7Q5Q7M76L46TXP456789',
    asset: 'XLM',
    amount: '15000',
  },
  createdAt: Date.now() - 30000,
  updatedAt: Date.now() - 10000,
  networkMode: 'testnet',
};

describe('BridgeForm - Order Recovery, Freshness, and Network Guard', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();

    // Default mock for prices endpoint
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/prices')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            xlmPerEth: 10000,
            ethUsd: 2500,
            xlmUsd: 0.25,
            source: 'cache',
            fetchedAt: Date.now(),
          }),
        } as Response;
      }

      if (urlStr.includes('/api/orders/order-xyz-123')) {
        return {
          ok: true,
          status: 200,
          json: async () => sampleOrder,
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'not found' }),
      } as Response;
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('restores open order from the coordinator API on reload/mount (AC 1)', async () => {
    setActiveOrderId('order-xyz-123');

    render(
      <BridgeForm
        ethAddress="0x1111111111111111111111111111111111111111"
        stellarAddress="GBBD6XCYNN45DA7CQ74TGMSW7CQJ2N4S7R4X7Q5Q7M76L46TXP456789"
        signStellarTransaction={vi.fn()}
        networkState={mockNetworkState}
      />
    );

    // Should fetch and show the order details
    await waitFor(() => {
      expect(screen.getByText('Order Details')).toBeInTheDocument();
    });

    expect(screen.getByText('order-xyz-123')).toBeInTheDocument();
    expect(screen.getAllByText(/src_locked/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/1.5 ETH/i)).toBeInTheDocument();
    expect(screen.getByText(/15000 XLM/i)).toBeInTheDocument();

    // Fresh order should have enabled Claim and Refund buttons
    const claimButton = screen.getByRole('button', { name: /Claim/i });
    const refundButton = screen.getByRole('button', { name: /Refund/i });
    expect(claimButton).toBeEnabled();
    expect(refundButton).toBeEnabled();
  });

  it('disables claim and refund when order is stale (AC 2)', async () => {
    const staleOrder: RecoveredOrder = {
      ...sampleOrder,
      status: 'expired',
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/orders/order-xyz-123')) {
        return {
          ok: true,
          status: 200,
          json: async () => staleOrder,
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    render(
      <BridgeForm
        ethAddress="0x1111111111111111111111111111111111111111"
        stellarAddress="GBBD6XCYNN45DA7CQ74TGMSW7CQJ2N4S7R4X7Q5Q7M76L46TXP456789"
        signStellarTransaction={vi.fn()}
        networkState={mockNetworkState}
        initialOrderId="order-xyz-123"
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Order Details')).toBeInTheDocument();
    });

    // Stale banner must be shown
    expect(screen.getByText(/Order is stale or expired/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Claim and refund actions are disabled/i)
    ).toBeInTheDocument();

    // Claim and Refund must be disabled
    const claimButton = screen.getByRole('button', { name: /Claim/i });
    const refundButton = screen.getByRole('button', { name: /Refund/i });
    const newBridgeButton = screen.getByRole('button', { name: /New Bridge/i });

    expect(claimButton).toBeDisabled();
    expect(refundButton).toBeDisabled();
    expect(newBridgeButton).toBeDisabled();
  });

  it('disables submit when wallet network has a mismatch (AC 3)', async () => {
    const mismatchNetworkState: NetworkModeState = {
      ...mockNetworkState,
      metamaskChainId: '0x1', // Mainnet instead of testnet
      metamaskMatches: false,
      hasAnyMismatch: true,
    };

    render(
      <BridgeForm
        ethAddress="0x1111111111111111111111111111111111111111"
        stellarAddress="GBBD6XCYNN45DA7CQ74TGMSW7CQJ2N4S7R4X7Q5Q7M76L46TXP456789"
        signStellarTransaction={vi.fn()}
        networkState={mismatchNetworkState}
      />
    );

    // Mismatch banner is rendered
    expect(screen.getByText(/Your wallet network does not match/i)).toBeInTheDocument();

    // Type an amount into the input
    const input = screen.getByPlaceholderText('0.0');
    await userEvent.type(input, '1.5');

    // Submit button must be disabled due to network mismatch
    const submitButton = screen.getByRole('button', { name: /^Network Mismatch$/i });
    expect(submitButton).toBeDisabled();
  });

  it('shows mismatch banner and disables actions when wallet does not match restored order network', async () => {
    // Order is for testnet, but app/wallet is switched to mainnet
    const mainnetState: NetworkModeState = {
      ...mockNetworkState,
      mode: 'mainnet',
      metamaskChainId: '0x1',
      hasAnyMismatch: false,
    };

    render(
      <BridgeForm
        ethAddress="0x1111111111111111111111111111111111111111"
        stellarAddress="GBBD6XCYNN45DA7CQ74TGMSW7CQJ2N4S7R4X7Q5Q7M76L46TXP456789"
        signStellarTransaction={vi.fn()}
        networkState={mainnetState}
        initialOrderId="order-xyz-123" // testnet order
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Order Details')).toBeInTheDocument();
    });

    // Mismatch banner for order network should be displayed
    expect(screen.getByText(/Your wallet network does not match the order network/i)).toBeInTheDocument();

    // Actions must be disabled
    expect(screen.getByRole('button', { name: /Claim/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Refund/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /New Bridge/i })).toBeDisabled();
  });

  it('ignores a late response for an older order id and does not replace current order (AC 4)', async () => {
    let resolveOrder1: (res: any) => void;
    const order1Promise = new Promise((resolve) => {
      resolveOrder1 = resolve;
    });

    const order1Data: RecoveredOrder = {
      ...sampleOrder,
      id: 'order-1-old',
      src: { ...sampleOrder.src, amount: '1.0' },
    };

    const order2Data: RecoveredOrder = {
      ...sampleOrder,
      id: 'order-2-new',
      src: { ...sampleOrder.src, amount: '2.0' },
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/orders/order-1-old')) {
        return order1Promise as Promise<Response>;
      }
      if (urlStr.includes('/api/orders/order-2-new')) {
        return {
          ok: true,
          status: 200,
          json: async () => order2Data,
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    const { rerender } = render(
      <BridgeForm
        ethAddress="0x1111111111111111111111111111111111111111"
        stellarAddress="GBBD6XCYNN45DA7CQ74TGMSW7CQJ2N4S7R4X7Q5Q7M76L46TXP456789"
        signStellarTransaction={vi.fn()}
        networkState={mockNetworkState}
        initialOrderId="order-1-old"
      />
    );

    // While order-1 request is in-flight, switch active order to order-2
    rerender(
      <BridgeForm
        ethAddress="0x1111111111111111111111111111111111111111"
        stellarAddress="GBBD6XCYNN45DA7CQ74TGMSW7CQJ2N4S7R4X7Q5Q7M76L46TXP456789"
        signStellarTransaction={vi.fn()}
        networkState={mockNetworkState}
        initialOrderId="order-2-new"
      />
    );

    // order-2 resolves quickly
    await waitFor(() => {
      expect(screen.getByText('order-2-new')).toBeInTheDocument();
    });
    expect(screen.getByText(/2.0 ETH/i)).toBeInTheDocument();

    // Now resolve the late response for order-1
    resolveOrder1!({
      ok: true,
      status: 200,
      json: async () => order1Data,
    });

    // Wait a tick to ensure any late resolution microtasks execute
    await new Promise((r) => setTimeout(r, 50));

    // Must STILL display order-2 and NOT replace it with order-1
    expect(screen.getByText('order-2-new')).toBeInTheDocument();
    expect(screen.queryByText('order-1-old')).not.toBeInTheDocument();
    expect(screen.queryByText(/1.0 ETH/i)).not.toBeInTheDocument();
  });

  it('keeps restored order visible when freshness request fails, with an explicit retry', async () => {
    setActiveOrderId('order-xyz-123');
    const { setActiveOrder } = await import('../lib/orderRecovery');
    setActiveOrder(sampleOrder);

    let fetchCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/orders/order-xyz-123')) {
        fetchCount++;
        if (fetchCount === 1) {
          // Freshness request fails on coordinator
          return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
          } as Response;
        }
        // Retry succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...sampleOrder, status: 'completed' as const }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    render(
      <BridgeForm
        ethAddress="0x1111111111111111111111111111111111111111"
        stellarAddress="GBBD6XCYNN45DA7CQ74TGMSW7CQJ2N4S7R4X7Q5Q7M76L46TXP456789"
        signStellarTransaction={vi.fn()}
        networkState={mockNetworkState}
      />
    );

    // Restored order remains visible even though freshness check failed
    await waitFor(() => {
      expect(screen.getByText('order-xyz-123')).toBeInTheDocument();
    });

    // Error banner is displayed with explicit retry button
    expect(
      screen.getByText(/Could not verify order freshness/i)
    ).toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: /Retry freshness/i });
    expect(retryButton).toBeInTheDocument();

    // Click retry
    await userEvent.click(retryButton);

    // After retry succeeds, error banner clears and status updates to completed
    await waitFor(() => {
      expect(
        screen.queryByText(/Could not verify order freshness/i)
      ).not.toBeInTheDocument();
    });

    expect(screen.getAllByText(/completed/i).length).toBeGreaterThanOrEqual(1);
  });
});
