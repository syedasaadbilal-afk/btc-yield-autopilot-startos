import type { RunMode } from "./runMode.js";

/**
 * Layered ("TWAP-style") execution for the illiquid BTC/XAUT pair
 * (design doc Section 8). A TrancheExecutionPlan slices one of the
 * 25/25/50 position-sizing tranches into smaller child clips.
 */
export interface TrancheExecutionPlan {
  trancheId: string;
  /** Fraction of the *target position change* this tranche represents, e.g. 0.25. */
  trancheWeight: number;
  side: "buy_btc_with_xaut" | "sell_btc_for_xaut";
  /** Total window the clips are spread across. */
  windowMs: number;
  numClips: number;
  clips: OrderClip[];
  /** Set if depth was too thin even after slicing and we fell back to legs. */
  legFallback?: {
    reason: string;
    btcUsdSymbol: string;
    xautUsdSymbol: string;
  };
}

export interface OrderClip {
  clipIndex: number;
  scheduledAt: number;
  /** Sized against visible order-book depth at placement time, not just trancheWeight/numClips. */
  maxFractionOfBookDepth: number;
  status: "pending" | "placed" | "filled" | "partially_filled" | "cancelled" | "rejected";
  exchangeOrderId?: string;
  filledBaseAmount?: number;
  avgFillPrice?: number;
}

export interface OrderBookDepthSnapshot {
  timestamp: number;
  symbol: string;
  /** Cumulative size available within a few price increments of top-of-book. */
  bidDepth: number;
  askDepth: number;
}

/**
 * Gate-stage check: reject or resize a clip if estimated slippage would eat
 * materially into the trade's edge. Slippage is a BTC cost since P&L is
 * BTC-denominated (design doc Section 0), not just a fee line item.
 */
export interface SlippageBudgetCheck {
  estimatedSlippageBtc: number;
  maxAllowedSlippageBtc: number;
  passes: boolean;
}

export interface ExecutionContext {
  runMode: RunMode;
  requestedAt: number;
}
