import type { Trade } from "./trade.js";

/**
 * One "long gold/XMR" round trip in TradingView's convention: Entry = the
 * flip INTO the rotation asset, Exit = the flip back to BTC.
 */
export interface AssetHold {
  id: string;
  entryAt?: number;
  entryPrice?: number; // asset-per-BTC (internal convention)
  exitAt?: number;
  exitPrice?: number;
  /** Real average-fill prices (same convention); absent for trades before order-level tracking. */
  actualEntryPrice?: number;
  actualExitPrice?: number;
  size?: number; // BTC capital at entry
  /** Headline PnL: from actual fills when both legs have them, else from signal prices. */
  pnl?: number;
  /** PnL computed purely from signal (bar close) prices, for comparison. */
  signalPnl?: number;
  pnlBasis?: "actual" | "signal";
}

/**
 * Derives TradingView-style asset-holding periods from the stored Trade rows,
 * which are BTC-holding periods (open on exit to BTC, close on re-entry to
 * the asset) - the inverse. The hold between trade[k] closing (entry into the
 * asset) and trade[k+1] opening (exit to BTC) is one round trip. A
 * bootstrap-inferred trade's own open never yields an exit (no real flip
 * happened), but its close is a real flip with a real price, so it still
 * works as a boundary. A hold whose entry pre-dates trade tracking has no
 * entry/PnL rather than invented numbers.
 */
export function deriveAssetHolds(trades: Trade[]): AssetHold[] {
  const seq = trades.filter((t) => t.status !== "cancelled").sort((a, b) => a.openedAt - b.openedAt);
  const holds: AssetHold[] = [];
  for (let k = 0; k < seq.length; k++) {
    const prev = seq[k - 1];
    const next = seq[k]!;
    if (next.notes?.includes("Bootstrap-inferred")) continue;
    const prevClosedAt = prev && prev.closedAt !== undefined ? prev.closedAt : undefined;
    const entryPrice = prev ? prev.exitPrice : undefined;
    const exitPrice = next.entryPrice;
    const actualEntryPrice = prev ? prev.actualExitPrice : undefined;
    const actualExitPrice = next.actualEntryPrice;
    let pnl: number | undefined;
    let signalPnl: number | undefined;
    let size: number | undefined;
    let pnlBasis: "actual" | "signal" | undefined;
    if (entryPrice && exitPrice && entryPrice > 0 && exitPrice > 0) {
      // asset-per-BTC: bought at r_in, sold at r_out => BTC out = in * r_in / r_out
      const growth = entryPrice / exitPrice;
      size = next.btcCapitalAtOpen / growth;
      signalPnl = next.btcCapitalAtOpen - size;
      pnl = signalPnl;
      pnlBasis = "signal";
    }
    if (actualEntryPrice && actualExitPrice && actualEntryPrice > 0 && actualExitPrice > 0) {
      const aSize = next.btcCapitalAtOpen / (actualEntryPrice / actualExitPrice);
      size = aSize;
      pnl = next.btcCapitalAtOpen - aSize;
      pnlBasis = "actual";
    }
    holds.push({
      id: next.id,
      ...(prevClosedAt !== undefined ? { entryAt: prevClosedAt } : {}),
      ...(entryPrice !== undefined ? { entryPrice } : {}),
      exitAt: next.openedAt,
      ...(exitPrice !== undefined ? { exitPrice } : {}),
      ...(actualEntryPrice !== undefined ? { actualEntryPrice } : {}),
      ...(actualExitPrice !== undefined ? { actualExitPrice } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(pnl !== undefined ? { pnl } : {}),
      ...(signalPnl !== undefined ? { signalPnl } : {}),
      ...(pnlBasis !== undefined ? { pnlBasis } : {}),
    });
  }
  const last = seq[seq.length - 1];
  if (last && last.closedAt !== undefined && last.status !== "open") {
    holds.push({
      id: `${last.id}-open`,
      entryAt: last.closedAt,
      ...(last.exitPrice !== undefined ? { entryPrice: last.exitPrice } : {}),
      ...(last.actualExitPrice !== undefined ? { actualEntryPrice: last.actualExitPrice } : {}),
    });
  }
  return holds;
}
