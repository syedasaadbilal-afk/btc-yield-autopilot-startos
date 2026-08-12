import type { NavPoint } from "@autopilot/shared";
import { formatBtcAmount, formatPercent, type DisplayUnit } from "../format.js";
import { LineChart } from "./LineChart.js";

/**
 * BTC-equivalent NAV curve (design doc Section 0: this is the primary chart,
 * not a USD equity curve) - headline yield/PnL numbers plus the chart itself,
 * styled to match Hashrate Autopilot's PRICE panel (big number + delta badge
 * above a dark line chart).
 */
export function NavChart({
  navHistory,
  startingBtc,
  unit,
  color = "#34d399",
  compact = false,
}: {
  navHistory: NavPoint[];
  /**
   * The pair's funded/cost-basis baseline. As of #95/#101, callers pass this
   * pair's FIRST-EVER NAV point (navHistory[0]) rather than a live-recomputed
   * percentage of total starting capital - capitalFractionBtc changes over
   * time (regime shifts, manual overrides), so using it as a cost basis made
   * "funded" silently drift every time allocation moved even though no new
   * capital was actually deployed (confirmed live, Aug 2026: a pair's funded
   * figure jumped the instant its target allocation changed). Yield/PnL here
   * is measured against whatever the caller passes, same formula as
   * packages/backtest/src/runLarssonBacktest.ts's totalBtcYieldFraction.
   */
  startingBtc: number;
  unit: DisplayUnit;
  color?: string;
  compact?: boolean;
}) {
  const values = navHistory.map((p) => p.btcEquivalentNav);
  const last = values.length > 0 ? values[values.length - 1]! : startingBtc;
  // Same formula as runLarssonBacktest.ts's totalBtcYieldFraction, so the
  // live number is directly comparable to the TradingView-backtested figure.
  const yieldFraction = startingBtc > 0 ? (last - startingBtc) / startingBtc : 0;
  const pnlBtc = last - startingBtc;

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-3 flex-wrap">
        <span className={compact ? "text-lg font-semibold text-slate-100" : "text-3xl font-semibold text-slate-100"}>
          {formatBtcAmount(last, unit)}
        </span>
        <span className={`text-sm font-semibold ${yieldFraction >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {formatPercent(yieldFraction)}
        </span>
        <span className={`text-xs ${pnlBtc >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          ({formatBtcAmount(pnlBtc, unit, { signed: true })} vs {formatBtcAmount(startingBtc, unit)} funded)
        </span>
      </div>
      <LineChart
        title="NAV"
        series={[{ label: "BTC-equivalent NAV", color, points: navHistory.map((p) => ({ x: p.timestamp, y: p.btcEquivalentNav })) }]}
        compactHeight={compact ? 80 : 140}
        expandedHeight={compact ? 160 : 260}
      />
    </div>
  );
}
