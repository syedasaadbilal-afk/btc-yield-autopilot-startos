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
   * The pair's actual funded/allocated BTC capital (status.startingBtc *
   * capitalFractionBtc) - NOT navHistory[0]. Yield/PnL must be measured
   * against this to match packages/backtest/src/runLarssonBacktest.ts's
   * totalBtcYieldFraction formula ((ending - startingBtc) / startingBtc);
   * using navHistory[0] instead breaks the moment the earliest DB row is a
   * stale/seed value (e.g. recorded before real capital was funded),
   * producing a yield% unrelated to actual PnL.
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
