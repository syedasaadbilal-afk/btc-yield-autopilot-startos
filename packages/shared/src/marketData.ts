/**
 * One currency's balance in a Bitfinex wallet (design doc Section 0: spot
 * wallet only). Used to bootstrap/reconcile currentPosition against real
 * holdings instead of trusting the trades table alone on a fresh pair with
 * no NAV history yet - see daemon/src/loop.ts's deriveBootstrapPosition -
 * and to cap order sizing against what's actually available before
 * submitting, rather than what the DB/NAV curve believes is held - see
 * daemon/src/execute.ts.
 */
export interface WalletBalance {
  walletType: "exchange" | "margin" | "funding";
  currency: string;
  balance: number;
  availableBalance: number;
}

/** OHLCV candle. Timestamps are Unix ms, UTC. */
export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A drawn trendline anchored on two or more swing points. */
export interface Trendline {
  /** Chronological anchor points the line is fit through. */
  anchors: Array<{ timestamp: number; price: number }>;
  /** Price the trendline projects to at a given timestamp. */
  slopePerMs: number;
  interceptPrice: number;
  interceptTimestamp: number;
}

export function trendlinePriceAt(line: Trendline, timestamp: number): number {
  return (
    line.interceptPrice +
    line.slopePerMs * (timestamp - line.interceptTimestamp)
  );
}

/** Fibonacci retracement sub-levels tracked for confluence (design doc Section 1). */
export const FIB_LEVELS = [0.382, 0.5, 0.618] as const;
export type FibLevel = (typeof FIB_LEVELS)[number];

export interface FibZone {
  legStart: { timestamp: number; price: number };
  legEnd: { timestamp: number; price: number };
  level: FibLevel;
  price: number;
}

/** A confluence zone: a Fib level that lines up with a trendline or swing point. */
export interface ConfluenceZone {
  fib: FibZone;
  trendline?: Trendline;
  priorSwing?: { timestamp: number; price: number };
  /** How tightly the fib/trendline/swing agree, as a fraction of price. Lower is tighter. */
  toleranceFraction: number;
}
