import type { StatusResponse } from "../api.js";
import type { NavPoint } from "@autopilot/shared";
import { formatBtcAmount, formatPercent, type DisplayUnit } from "../format.js";

/** Portfolio-level P&L summary - mirrors Hashrate Autopilot's "PROFIT & LOSS · LIFETIME" card. */
export function PortfolioPnl({
  status,
  navByPair,
  unit,
}: {
  status: StatusResponse;
  navByPair: Record<string, NavPoint[]>;
  unit: DisplayUnit;
}) {
  let totalNav = 0;
  let totalFunded = 0;
  const perPair = status.pairs.map((pair) => {
    const hist = navByPair[pair.pairKey] ?? [];
    // Funded/cost-basis baseline (task #95): use this pair's FIRST-EVER NAV
    // point instead of a live-recomputed percentage of total starting
    // capital. pair.capitalFractionBtc is the CURRENT dynamic allocation
    // (regime-driven, or manually overridden via the Config tab) and
    // changes over time - using it here meant "funded" silently shifted
    // every time allocation moved, even though no new capital was actually
    // deployed (e.g. XMR's funded jumped from 0.00375 to 0.0045 BTC the
    // moment its target allocation moved from 50% to 60%, even though that
    // 0.00075 BTC was never really contributed). hist is ascending (see
    // repo.getNavHistory's ORDER BY timestamp ASC), so hist[0] is the
    // earliest recorded value - falls back to the old fraction-based
    // estimate only before this pair has any NAV history yet (its very
    // first tick).
    const funded = hist.length > 0 ? hist[0]!.btcEquivalentNav : status.startingBtc * pair.capitalFractionBtc;
    const nav = hist.length > 0 ? hist[hist.length - 1]!.btcEquivalentNav : funded;
    totalNav += nav;
    totalFunded += funded;
    const pnl = nav - funded;
    const yieldFraction = funded > 0 ? pnl / funded : 0;
    return { pair, funded, nav, pnl, yieldFraction };
  });
  const portfolioPnl = totalNav - totalFunded;
  const portfolioYield = totalFunded > 0 ? portfolioPnl / totalFunded : 0;
  return (
    <div className="bg-ink-900 border border-slate-800 rounded-lg p-4">
      <h3 className="text-xs font-semibold tracking-wider text-slate-300 uppercase mb-3">Profit &amp; loss · portfolio</h3>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-slate-500">funded (whole portfolio)</span>
          <span className="text-slate-300">{formatBtcAmount(totalFunded, unit)}</span>
        </div>
        {perPair.map(({ pair, pnl, yieldFraction }) => (
          <div key={pair.pairKey} className="flex items-baseline justify-between text-sm pl-3">
            <span className="text-slate-500">
              + {pair.displayName.split(" ")[0]} PnL ({(pair.capitalFractionBtc * 100).toFixed(0)}% alloc)
            </span>
            <span className={pnl >= 0 ? "text-emerald-400" : "text-red-400"}>
              {formatBtcAmount(pnl, unit, { signed: true })} ({formatPercent(yieldFraction)})
            </span>
          </div>
        ))}
      </div>
      <div className="border-t border-slate-700 mt-3 pt-2 flex items-baseline justify-between">
        <span className="text-slate-300 font-semibold text-sm">net BTC PnL</span>
        <span className={`font-bold text-lg ${portfolioPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {formatBtcAmount(portfolioPnl, unit, { signed: true })}
        </span>
      </div>
      <div className="flex items-baseline justify-between mt-1">
        <span className="text-slate-500 text-xs">return on funded capital</span>
        <span className={`text-sm font-semibold ${portfolioYield >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {formatPercent(portfolioYield)}
        </span>
      </div>
    </div>
  );
}
