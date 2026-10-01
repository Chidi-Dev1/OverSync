import { randomBytes } from "node:crypto";
import type { Logger } from "pino";

export interface PriceQuote {
  /** Stable opaque id that callers can reference back to this exact quote. */
  quoteId: string;
  pair: string;
  /** Decimal string. `srcUsd` and `dstUsd` are USD per unit of src/dst. */
  srcUsd: string | null;
  dstUsd: string | null;
  /** Source: coingecko, oneinch, cache, etc. */
  source: "coingecko" | "oneinch" | "cache" | "unknown";
  /** Unix ms when the quote was first issued. */
  issuedAt: number;
  /** Unix ms after which this quote must not be used to fill an order. */
  expiresAt: number;
  /**
   * Source amount this quote was issued for, as a base-unit integer
   * string (e.g. wei). When set, an order must announce exactly this
   * `srcAmount` or it is rejected.
   */
  amountBaseUnits?: string;
}

export class AmountParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountParseError";
  }
}

export class QuoteAmountMismatchError extends Error {
  constructor(
    public readonly quoteId: string,
    public readonly quotedAmount: string,
    public readonly orderAmount: string
  ) {
    super(`Quote ${quoteId} was issued for ${quotedAmount} base units, order announced ${orderAmount}`);
    this.name = "QuoteAmountMismatchError";
  }
}

const BASE_UNIT_INTEGER = /^(0|[1-9]\d*)$/;
const DECIMAL_AMOUNT = /^(\d+)(?:\.(\d*))?$|^\.(\d+)$/;

/**
 * Parse a user-entered decimal amount into token base units using only
 * string/BigInt arithmetic (no floating point). This is the same
 * algorithm as `parseAmountToBaseUnits` in
 * `frontend/src/lib/sanitizeAmountInput.ts`, so the form and the
 * coordinator always agree on the integer.
 *
 * Rejects empty input, signs, exponents, and more fractional digits than
 * the asset's `decimals` allows (never rounds or truncates).
 */
export function parseAmountToBaseUnits(input: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AmountParseError(`invalid decimals: ${decimals}`);
  }
  const text = input.trim();
  const m = DECIMAL_AMOUNT.exec(text);
  if (!m) {
    throw new AmountParseError(`amount must be a non-negative decimal: "${input}"`);
  }
  const whole = m[1] ?? "0";
  const frac = m[2] ?? m[3] ?? "";
  if (frac.length > decimals) {
    throw new AmountParseError(
      `amount has ${frac.length} fractional digits, asset allows ${decimals}`
    );
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Validate a base-unit integer string (as sent by the form) and return it canonicalised. */
export function parseBaseUnitInteger(value: string): string {
  if (!BASE_UNIT_INTEGER.test(value)) {
    throw new AmountParseError(`amount must be a base-unit integer string: "${value}"`);
  }
  return BigInt(value).toString();
}

export class QuoteExpiredError extends Error {
  constructor(
    public readonly quoteId: string,
    public readonly expiredMs: number
  ) {
    const staleMs = Date.now() - expiredMs;
    super(`Quote ${quoteId} expired ${staleMs} ms ago`);
    this.name = "QuoteExpiredError";
  }
}

export class QuoteNotFoundError extends Error {
  constructor(public readonly quoteId: string) {
    super(`Quote ${quoteId} not found or already evicted`);
    this.name = "QuoteNotFoundError";
  }
}

/**
 * Minimal real-data price service. Reads from CoinGecko's free
 * (no-API-key) endpoint; if the call fails we surface a `null` price
 * instead of a fabricated number, so callers can decide to render
 * "price unavailable" rather than misleading data.
 *
 * Every response carries a `quoteId` that resolvers (and the order
 * announce endpoint) can reference.  `assertFresh(quoteId)` rejects
 * fills that reference stale quotes before any chain action is
 * attempted, satisfying the quote-freshness enforcement requirement.
 */
export class QuoteService {
  /** In-flight / recently-issued quotes, keyed by quoteId. */
  private readonly quotes = new Map<string, PriceQuote>();
  /** Cached CoinGecko response, keyed by pair name. */
  private readonly priceCache = new Map<string, PriceQuote>();
  private readonly cacheTtlMs = 30_000;

  constructor(
    private readonly log: Logger,
    /** Injected for testing — defaults to Date.now(). */
    private readonly now: () => number = Date.now
  ) {}

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  /**
   * Fetch (or return a cached) ETH/XLM price quote.
   * The returned object always has a unique `quoteId` so callers
   * can reference it when announcing an order.
   */
  async quoteEthXlm(opts: { amountBaseUnits?: string } = {}): Promise<PriceQuote> {
    const amountBaseUnits =
      opts.amountBaseUnits === undefined ? undefined : parseBaseUnitInteger(opts.amountBaseUnits);
    const cached = this.priceCache.get("ETH-XLM");
    if (cached && this.now() < cached.expiresAt) {
      // Re-issue a *new* quoteId that shares the same price data.
      // This ensures each API response has a distinct, trackable id
      // while still benefiting from the price cache.
      const reissued: PriceQuote = {
        ...cached,
        quoteId: this.newQuoteId(),
        source: "cache",
        issuedAt: this.now(),
        amountBaseUnits
      };
      this.quotes.set(reissued.quoteId, reissued);
      this.log.debug({ quoteId: reissued.quoteId, pair: "ETH-XLM" }, "quote reissued from cache");
      return reissued;
    }

    let ethUsd: string | null = null;
    let xlmUsd: string | null = null;
    let source: PriceQuote["source"] = "unknown";

    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,stellar&vs_currencies=usd",
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) throw new Error(`coingecko ${res.status}`);
      const body = (await res.json()) as Record<string, { usd?: number }>;
      ethUsd = body.ethereum?.usd?.toString() ?? null;
      xlmUsd = body.stellar?.usd?.toString() ?? null;
      source = "coingecko";
    } catch (err) {
      this.log.warn({ err }, "coingecko quote failed — returning null prices");
    }

    const quoteId = this.newQuoteId();
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.cacheTtlMs;

    const quote: PriceQuote = {
      quoteId,
      pair: "ETH-XLM",
      srcUsd: ethUsd,
      dstUsd: xlmUsd,
      source,
      issuedAt,
      expiresAt
    };

    this.priceCache.set("ETH-XLM", quote);
    if (amountBaseUnits !== undefined) {
      // The price cache is shared; only the per-id record carries the amount.
      const bound: PriceQuote = { ...quote, amountBaseUnits };
      this.quotes.set(quoteId, bound);
      this.log.debug({ quoteId, source }, "quote issued");
      return bound;
    }
    this.quotes.set(quoteId, quote);
    this.log.debug({ quoteId, source }, "quote issued");
    return quote;
  }

  /**
   * Look up a previously issued quote by its id.
   * Returns `null` when the quote has been evicted (too old) or
   * was never known.
   */
  getById(quoteId: string): PriceQuote | null {
    return this.quotes.get(quoteId) ?? null;
  }

  /**
   * Assert that a quote exists **and** has not expired.
   *
   * Throws `QuoteNotFoundError` when the id is unknown.
   * Throws `QuoteExpiredError` when `now > expiresAt`.
   *
   * Resolvers and the order-announce handler call this before
   * attempting any on-chain action so fills using stale prices
   * are rejected deterministically before gas is spent.
   *
   * When `orderAmountBaseUnits` is given and the quote was issued for an
   * amount, the two integers must be identical, otherwise
   * `QuoteAmountMismatchError` is thrown.
   */
  assertFresh(quoteId: string, orderAmountBaseUnits?: string): PriceQuote {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      throw new QuoteNotFoundError(quoteId);
    }
    if (this.now() > quote.expiresAt) {
      this.log.warn(
        { quoteId, expiredMs: quote.expiresAt, nowMs: this.now() },
        "stale quote rejected"
      );
      throw new QuoteExpiredError(quoteId, quote.expiresAt);
    }
    if (quote.amountBaseUnits !== undefined && orderAmountBaseUnits !== undefined) {
      const orderAmount = parseBaseUnitInteger(orderAmountBaseUnits);
      if (orderAmount !== quote.amountBaseUnits) {
        throw new QuoteAmountMismatchError(quoteId, quote.amountBaseUnits, orderAmount);
      }
    }
    return quote;
  }

  /**
   * Remove all quotes whose `expiresAt` is in the past.
   * Called periodically to prevent unbounded memory growth.
   */
  evictExpired(): number {
    const now = this.now();
    let count = 0;
    for (const [id, q] of this.quotes) {
      if (now > q.expiresAt) {
        this.quotes.delete(id);
        count++;
      }
    }
    if (count > 0) {
      this.log.debug({ evicted: count }, "expired quotes evicted");
    }
    return count;
  }

  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------

  private newQuoteId(): string {
    return randomBytes(16).toString("hex");
  }
}
