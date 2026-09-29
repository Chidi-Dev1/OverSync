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

    // Proceed with v2 escrow order building
    return this.buildV2EscrowOrder(request);
  }

  private async buildV2EscrowOrder(request: LockRequest): Promise<any> {
    // Implementation for v2 escrow order building
    return {
      type: 'v2_escrow_lock',
      ...request
    };
  }
}
