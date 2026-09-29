export type TimelockValidationError = 'TIMELOCKS_REVERSED' | 'GAP_TOO_SMALL';

export type RefundChain = 'ethereum' | 'stellar';

export interface RefundEligibility {
  eligible: boolean;
  lockedSides: Array<{
    chain: RefundChain;
    earliestRefundAt: number | null;
  }>;
}

/** Evaluates both persisted chain timelocks using one coordinator clock. */
export function evaluateRefundEligibility(
  timelocks: Record<RefundChain, number | null>,
  nowUnixSeconds: number
): RefundEligibility {
  const lockedSides = (Object.entries(timelocks) as Array<[RefundChain, number | null]>)
    .filter(([, timelock]) => timelock === null || nowUnixSeconds <= timelock)
    .map(([chain, timelock]) => ({
      chain,
      earliestRefundAt: timelock === null ? null : timelock + 1
    }));

  return { eligible: lockedSides.length === 0, lockedSides };
}

/**
 * Validates that the destination timelock is safely before the source timelock.
 *
 * @param srcTimelock The source chain timelock (in seconds)
 * @param dstTimelock The destination chain timelock (in seconds)
 * @param minGapSeconds The minimum required gap between timelocks (in seconds)
 * @returns An object indicating validity and an optional error type
 */
export function validateTimelockOrdering(
  srcTimelock: number,
  dstTimelock: number,
  minGapSeconds: number
): { isValid: boolean; error?: TimelockValidationError } {
  if (dstTimelock >= srcTimelock) {
    return { isValid: false, error: 'TIMELOCKS_REVERSED' };
  }
  if (srcTimelock - dstTimelock < minGapSeconds) {
    return { isValid: false, error: 'GAP_TOO_SMALL' };
  }
  return { isValid: true };
}

/**
 * Validates source/destination timelock ordering at order-creation time.
 * Alias for {@link validateTimelockOrdering} used by the coordinator service layer.
 */
export function validateTimelocksAtCreation(
  srcTimelock: number,
  dstTimelock: number,
  minGapSeconds: number
): { isValid: boolean; error?: TimelockValidationError } {
  return validateTimelockOrdering(srcTimelock, dstTimelock, minGapSeconds);
}
