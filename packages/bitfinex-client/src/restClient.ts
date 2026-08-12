import type { Candle, OrderBookDepthSnapshot, RunMode, WalletBalance } from "@autopilot/shared";
import { buildAuthHeaders, MonotonicNonce } from "./auth.js";
import { RateLimiter } from "./rateLimiter.js";

export interface BitfinexClientConfig {
  apiKey: string;
  apiSecret: string;
  /**
   * Bitfinex API v2 base URL. Same host is used for LIVE and PAPER - PAPER
   * trades against a paper-trading subaccount identified by its own API
   * key/secret pair, not a different URL. TODO: confirm current paper
   * subaccount setup flow against Bitfinex docs before first PAPER run,
   * since exchange-side paper trading features can change.
   */
  baseUrl: string;
  runMode: RunMode;
}

export interface SpotOrderRequest {
  symbol: string; // e.g. "tBTC:XAUT"
  amount: number; // positive = buy, negative = sell (Bitfinex convention)
  price: string;
  type: "EXCHANGE LIMIT" | "EXCHANGE MARKET";
  clientOrderId?: number;
}

export interface SpotOrderResult {
  submitted: boolean;
  dryRun: boolean;
  exchangeOrderId?: string;
  raw?: unknown;
}

type FetchLike = typeof fetch;

export class BitfinexRestClient {
  private readonly nonce = new MonotonicNonce();
  private readonly limiter = new RateLimiter(30, 30 / 60_000); // ~30 req/min, conservative default
  // Cache for getMinOrderSize (task #94) - minimum order sizes are an
  // exchange config value, not a live market figure, so a long TTL avoids
  // hitting the public conf endpoint on every tranche of every tick.
  private pairInfoCache: { at: number; bySymbol: Map<string, number> } | null = null;
  private static readonly PAIR_INFO_CACHE_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly config: BitfinexClientConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  // ---- Public market data (no auth required) ----

  async getCandles(symbol: string, timeframe: "1D" | "4h", limit: number): Promise<Candle[]> {
    await this.waitForToken();
    const url = `${this.config.baseUrl}/v2/candles/trade:${timeframe}:${symbol}/hist?limit=${limit}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`getCandles failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as number[][];
    // Bitfinex candle row: [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]
    return rows
      .map((r) => ({
        timestamp: r[0]!,
        open: r[1]!,
        close: r[2]!,
        high: r[3]!,
        low: r[4]!,
        volume: r[5]!,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async getBookDepth(symbol: string, precision = "P0"): Promise<OrderBookDepthSnapshot> {
    await this.waitForToken();
    const url = `${this.config.baseUrl}/v2/book/${symbol}/${precision}?len=25`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`getBookDepth failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as number[][];
    // Row: [PRICE, COUNT, AMOUNT]. Positive amount = bid, negative = ask.
    let bidDepth = 0;
    let askDepth = 0;
    for (const [, , amount] of rows) {
      if (amount === undefined) continue;
      if (amount > 0) bidDepth += amount;
      else askDepth += Math.abs(amount);
    }
    return { timestamp: Date.now(), symbol, bidDepth, askDepth };
  }

  /**
   * Exchange minimum order size for a symbol (task #94), asset-denominated
   * to match Bitfinex's own convention: the minimum for a pair like
   * "XAUT:BTC" is quoted in XAUT (the pair's BASE currency), not BTC - the
   * same currency submitOrder's `amount` field uses for that symbol. Reads
   * the public pub:info:pair conf endpoint (no auth), which returns EVERY
   * pair in one response rather than supporting a per-symbol filter, so the
   * full list is parsed once and cached rather than re-fetched per call.
   * Returns 0 (no constraint) for a symbol not present in the response
   * rather than throwing, so a temporarily-missing/renamed pair degrades to
   * the old unconstrained behavior instead of blocking a tick.
   */
  async getMinOrderSize(symbol: string): Promise<number> {
    const now = Date.now();
    if (!this.pairInfoCache || now - this.pairInfoCache.at > BitfinexRestClient.PAIR_INFO_CACHE_MS) {
      await this.waitForToken();
      const url = `${this.config.baseUrl}/v2/conf/pub:info:pair`;
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`getMinOrderSize fetch failed: ${res.status} ${await res.text()}`);
      const raw = (await res.json()) as [[string, (string | number | null)[]][]];
      const bySymbol = new Map<string, number>();
      for (const entry of raw[0] ?? []) {
        const [pair, info] = entry;
        const minSize = info[3];
        if (minSize !== null && minSize !== undefined) {
          bySymbol.set(pair, Number(minSize));
        }
      }
      this.pairInfoCache = { at: now, bySymbol };
    }
    // Bitfinex's conf response omits the "t" trading prefix our symbols carry (e.g. "tXAUT:BTC" -> "XAUT:BTC").
    const key = symbol.startsWith("t") ? symbol.slice(1) : symbol;
    return this.pairInfoCache.bySymbol.get(key) ?? 0;
  }

  // ---- Private trading endpoints (auth required) ----

  /**
   * Real wallet balances (design doc Section 0: spot wallet only, so this
   * only surfaces the "exchange" wallet type in practice). Unlike
   * submitOrder(), this is a read-only call that hits the network even in
   * DRY_RUN - it's the ground truth deriveBootstrapPosition() (loop.ts) and
   * the balance cap (execute.ts) both need to be trustworthy in every run
   * mode, not just LIVE.
   */
  async getWallets(): Promise<WalletBalance[]> {
    await this.waitForToken();
    const path = "v2/auth/r/wallets";
    const body = "";
    const nonce = this.nonce.next();
    const headers = {
      "Content-Type": "application/json",
      ...buildAuthHeaders({
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
        path,
        nonce,
        body,
      }),
    };
    const res = await this.fetchImpl(`${this.config.baseUrl}/${path}`, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) throw new Error(`getWallets failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as [string, string, number, number, number, ...unknown[]][];
    // Row: [WALLET_TYPE, CURRENCY, BALANCE, UNSETTLED_INTEREST, AVAILABLE_BALANCE, ...]
    return rows
      .filter((r) => r[0] === "exchange")
      .map((r) => ({
        walletType: r[0] as WalletBalance["walletType"],
        currency: r[1],
        balance: r[2],
        // AVAILABLE_BALANCE can be null from Bitfinex when it hasn't been computed
        // (e.g. no open orders to net against) - fall back to the raw balance.
        availableBalance: r[4] ?? r[2],
      }));
  }

  /**
   * Submits a spot order. In DRY_RUN mode this never hits the network - it
   * logs the would-be order and returns a synthetic result, matching the
   * design doc's DRY_RUN discipline at the lowest layer as defense in depth
   * (the daemon's gate stage should already prevent this call in DRY_RUN,
   * but the client itself refuses too).
   */
  async submitOrder(order: SpotOrderRequest): Promise<SpotOrderResult> {
    if (this.config.runMode === "DRY_RUN") {
      // eslint-disable-next-line no-console
      console.log("[DRY_RUN] would submit order:", order);
      return { submitted: false, dryRun: true };
    }

    await this.waitForToken();
    const path = "v2/auth/w/order/submit";
    const body = JSON.stringify({
      type: order.type,
      symbol: order.symbol,
      amount: String(order.amount),
      price: order.price,
      ...(order.clientOrderId ? { cid: order.clientOrderId } : {}),
    });
    const nonce = this.nonce.next();
    const headers = {
      "Content-Type": "application/json",
      ...buildAuthHeaders({
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
        path,
        nonce,
        body,
      }),
    };
    const res = await this.fetchImpl(`${this.config.baseUrl}/${path}`, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) throw new Error(`submitOrder failed: ${res.status} ${await res.text()}`);
    const raw = await res.json();
    return { submitted: true, dryRun: false, raw };
  }

  private async waitForToken(): Promise<void> {
    while (!this.limiter.tryAcquire()) {
      await new Promise((r) => setTimeout(r, this.limiter.msUntilNextToken()));
    }
  }
}
