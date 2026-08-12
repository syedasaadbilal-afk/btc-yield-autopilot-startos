import { useEffect, useState } from "react";
import type { StatusResponse } from "../api.js";
import type { Trade } from "@autopilot/shared";
import { fetchTrades } from "../api.js";
import { formatBtcAmount, formatPercent, type DisplayUnit } from "../format.js";

/**
 * Portfolio-level P&L summary - mirrors Hashrate Autopilot's "PROFIT & LOSS ·
 * LIFETIME" card.
 *
 * PnL here is TRADE-BASED (sum of realizedBtcPnl across each pair's closed
 * trades, portfolio total = sum of both pairs), not a NAV-snapshot delta.
 * Explicit product decision: a NAV-curve calculation ("current mark-to-market
 * value minus some funded baseline") kept disagreeing with itself across the
 * dashboard depending on which baseline was used (live allocation fraction
 * vs first-ever NAV point), which is exactly the confusion that drove #95's
 * fix and the funded/PnL bugs found live in this same round. Trade entries
 * and exits (task #86, loop.ts's realizedBtcPnl) are the actual ground truth
 * of what happened - this card sums that directly instead of maintaining a
 * second, parallel PnL calculation that can drift from it. A consequence:
 * this reads 0.00 BTC for a pair (or the whole portfolio) until at least one
 * trade has actually CLOSED - no gain/loss is "realized" before that, by
 * definition, even if the NAV curve has moved around in the meantime.
 */
export function PortfolioPnl({ status, unit }: { status: StatusResponse; unit: DisplayUnit }) {
  const [tradesByPair, setTradesByPair] = useState<Record<string, Trade[]>>({});
  const pairKeys = status.pairs.map((p) => p.pairKey).join(",");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const entries = await Promise.all(
        status.pairs.map(async (pair) => [pair.pairKey, await fetchTrades(pair.pairKey, 500)] as const)
      );
      if (!cancelled) setTradesByPair(Object.fromEntries(entries));
    }
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKeys]);

  const perPair = status.pairs.map((pair) => {
    const trades = tradesByPair[pair.pairKey] ?? [];
    const closed = trades.filter((t) => t.status === "closed_win" || t.status === "closed_loss");
    const pnl = closed.reduce((sum, t) => sum + (t.realizedBtcPnl ?? 0), 0);
    const capitalAtRisk = closed.reduce((sum, t) => sum + t.btcCapitalAtOpen, 0);
    const yieldFraction = capitalAtRisk > 0 ? pnl / capitalAtRisk : 0;
    return { pair, pnl, yieldFraction, closedCount: closed.length };
  });
  const portfolioPnl = perPair.reduce((sum, p) => sum + p.pnl, 0);

  return (
    <div className="bg-ink-900 border border-slate-800 rounded-lg p-4">
      <h3 className="text-xs font-semibold tracking-wider text-slate-300 uppercase mb-3">
        Profit &amp; loss · portfolio (closed trades)
      </h3>
      <div className="space-y-1.5">
        {perPair.map(({ pair, pnl, yieldFraction, closedCount }) => (
          <div key={pair.pairKey} className="flex items-baseline justify-between text-sm">
            <span className="text-slate-500">
              {pair.displayName.split(" ")[0]} PnL ({closedCount} closed trade{closedCount === 1 ? "" : "s"})
            </span>
            <span className={pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
              {formatBtcAmount(pnl, unit, { signed: true })}
              {closedCount > 0 ? ` (${formatPercent(yieldFraction)})` : ""}
            </span>
          </div>
        ))}
      </div>
      <div className="border-t border-slate-700 mt-3 pt-2 flex items-baseline justify-between">
        <span className="text-slate-300 font-semibold text-sm">net BTC PnL (sum of both pairs)</span>
        <span className={`font-bold text-lg ${portfolioPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {formatBtcAmount(portfolioPnl, unit, { signed: true })}
        </span>
      </div>
      {perPair.every((p) => p.closedCount === 0) && (
        <p className="text-xs text-slate-500 italic mt-2">
          No trades have closed yet - realized PnL is 0 until a rotation actually exits.
        </p>
      )}
    </div>
  );
}
