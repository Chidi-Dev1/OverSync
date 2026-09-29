export interface OrderLeg {
  chain: 'ethereum' | 'stellar';
  address: string;
  asset: string;
  amount: string;
  safetyDeposit?: string;
  orderId?: string | null;
  lockTx?: string | null;
  lockBlock?: number | null;
  timelock?: number | null;
}

export type RecoveredOrderStatus =
  | 'announced'
  | 'src_locked'
  | 'dst_locked'
  | 'secret_revealed'
  | 'completed'
  | 'refunded'
  | 'failed'
  | 'expired';

export interface RecoveredOrder {
  id: string;
  direction: 'eth_to_xlm' | 'xlm_to_eth';
  status: RecoveredOrderStatus;
  hashlock: string;
  src: OrderLeg;
  dst: OrderLeg;
  secret?: {
    revealed: boolean;
    preimage: string | null;
    revealedTx?: string | null;
  };
  resolver?: string | null;
  createdAt: number;
  updatedAt: number;
  networkMode?: 'testnet' | 'mainnet';
  isStale?: boolean;
}

export const ACTIVE_ORDER_ID_KEY = 'oversync_active_order_id';
export const ACTIVE_ORDER_DATA_KEY = 'oversync_active_order_data';

const PRODUCTION_API_BASE_URL = 'https://oversync-k36vx.ondigitalocean.app';

export function resolveApiBaseUrl(): string {
  if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
    if ((import.meta as any).env.PROD) return '';
    if ((import.meta as any).env.VITE_API_BASE_URL) {
      return (import.meta as any).env.VITE_API_BASE_URL;
    }
  }
  return PRODUCTION_API_BASE_URL;
}

export function getActiveOrderId(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(ACTIVE_ORDER_ID_KEY);
  } catch {
    return null;
  }
}

export function setActiveOrderId(id: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (id) {
      localStorage.setItem(ACTIVE_ORDER_ID_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_ORDER_ID_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

export function clearActiveOrderId(): void {
  setActiveOrderId(null);
}

export function getActiveOrder(): RecoveredOrder | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(ACTIVE_ORDER_DATA_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as RecoveredOrder;
  } catch {
    return null;
  }
}

export function setActiveOrder(order: RecoveredOrder | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (order) {
      localStorage.setItem(ACTIVE_ORDER_DATA_KEY, JSON.stringify(order));
      localStorage.setItem(ACTIVE_ORDER_ID_KEY, order.id);
    } else {
      localStorage.removeItem(ACTIVE_ORDER_DATA_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

export function clearActiveOrder(): void {
  setActiveOrder(null);
  clearActiveOrderId();
}

/**
 * Fetch an order by publicId from the coordinator / relayer API.
 */
export async function fetchOrderById(
  id: string,
  options?: { baseUrl?: string; signal?: AbortSignal }
): Promise<RecoveredOrder | null> {
  const baseUrl = options?.baseUrl !== undefined ? options.baseUrl : resolveApiBaseUrl();
  const url = `${baseUrl}/api/orders/${encodeURIComponent(id)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
    signal: options?.signal,
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Coordinator returned error status ${response.status}`);
  }

  const data = (await response.json()) as RecoveredOrder;
  return data;
}

/**
 * Validates that a response for `responseOrderId` should replace current order,
 * ignoring any late response for an older or different order id.
 */
export function isResponseForCurrentOrder(
  currentOrderId: string | null,
  responseOrderId: string
): boolean {
  if (!currentOrderId) return false;
  return currentOrderId.trim().toLowerCase() === responseOrderId.trim().toLowerCase();
}

/**
 * Manages request sequencing and tracks current order id to reject
 * out-of-order or late arriving responses.
 */
export class OrderRecoveryTracker {
  private currentId: string | null = null;
  private sequence: number = 0;

  startRequest(orderId: string): number {
    this.currentId = orderId;
    this.sequence += 1;
    return this.sequence;
  }

  isCurrent(orderId: string, seq?: number): boolean {
    if (!this.currentId) return false;
    if (this.currentId.toLowerCase() !== orderId.toLowerCase()) {
      return false;
    }
    if (seq !== undefined && seq !== this.sequence) {
      return false;
    }
    return true;
  }

  getCurrentId(): string | null {
    return this.currentId;
  }

  reset(): void {
    this.currentId = null;
    this.sequence += 1;
  }
}
