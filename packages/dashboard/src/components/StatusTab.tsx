import type { NavPoint, RunMode } from "@autopilot/shared";
import type { StatusResponse } from "../api.js";
import { formatBtcAmount, formatCountdown, type DisplayUnit } from "../format.js";
import { RunModeToggle } from "./RunModeToggle.js";
import { MetricTile } from "./MetricTile.js";
import { PairPanel } from "./PairPanel.js";
import { PortfolioPnl } from "./PortfolioPnl.js";
import { LineChart } from "./LineChart.js";

const PAIR_COLORS: Record<string, string> = {
  xaut: "#f2c94c",
  xmr: "#38bdf8",
};

function statusHeadline(status: StatusResponse): string {
  const gold = status.pairs.filter((p) => p.regime === "orange");
  const others = status.pairs.filter((p) => p.regime !== "orange");
  if (gold.length === 0) {
    return "Both pairs blue/gray - portfolio effectively sits in BTC.";
  }
  if (gold.length === status.pairs.length) {
    // Report the REAL split (capitalFractionBtc), not a hardcoded "split
    // evenly" - a manual allocation override (Config tab) can pin this away
    // from 50/50 even when both pairs are gold (bug found live, Aug 2026:
    // this said "split evenly" while the tiles right below it showed 40/60).
    const splitDesc = gold
      .map((p) => `${p.displayName.split(" ")[0]} ${(p.capitalFractionBtc * 100).toFixed(0)}%`)
      .join(", ");
    return `All pairs gold (${splitDesc}).`;
  }
  return `${gold.map((p) => p.displayName.split(" ")[0]).join(", ")} gold, ${others
    .map((p) => p.displayName.split(" ")[0])
    .join(", ")} blue/gray - full allocation to the gold pair.`;
}

/**
 * Per-pair funded/cost-basis baseline (task #95/#101): use this pair's
 * FIRST-EVER recorded NAV point instead of a live-recomputed percentage of
 * total starting capital. capitalFractionBtc is the CURRENT dynamic
 * allocation (regime-driven, or manually overridden) and changes over time -
 * using it as a cost basis means "funded" silently shifts every time
 * allocation moves even though no new capital was actually deployed. hist is
 * ascending (repo.getNavHistory's ORDER BY timestamp ASC), so hist[0] is the
 * earliest recorded value; falls back to the fraction-based estimate only
 * before this pair has any NAV history yet (its very first tick).
 */
function pairFundedBtc(hist: NavPoint[], fallback: number): number {
  return hist.length > 0 ? hist[0]!.btcEquivalentNav : fallback;
}

export function StatusTab({
  status,
  navByPair,
  unit,
  runningNow,
  onRunNow,
  onModeChange,
}: {
  status: StatusResponse | undefined;
  navByPair: Record<string, NavPoint[]>;
  unit: DisplayUnit;
  runningNow: boolean;
  onRunNow: () => void;
  onModeChange: (mode: RunMode) => void;
}) {
  if (!status) {
    return <div className="text-slate-500 p-6">Loading...</div>;
  }

  // Per-pair "deployed" = this pair's current mark-to-market BTC-equivalent
  // NAV (navByPair's latest point) - by construction, summing these across
  // pairs always equals totalNav exactly, since totalNav IS that sum. Per
  // explicit direction: the hero no longer shows a "Funded" figure at all
  // (it was a recurring source of confusion, see #95/#101) - deployed
  // capital per pair is the more useful, always-self-consistent number.
  // fundedByPair is still used further down inside each PairPanel's own
  // mark-to-market vs cost-basis chart, which is a separate, still-valid view.
  let totalNav = 0;
  const fundedByPair: Record<string, number> = {};
  const deployedByPair: Record<string, number> = {};
  for (const pair of status.pairs) {
    const hist = navByPair[pair.pairKey] ?? [];
    const funded = pairFundedBtc(hist, status.startingBtc * pair.capitalFractionBtc);
    const nav = hist.length > 0 ? hist[hist.length - 1]!.btcEquivalentNav : funded;
    fundedByPair[pair.pairKey] = funded;
    deployedByPair[pair.pairKey] = nav;
    totalNav += nav;
  }

  return (
    <div className="space-y-6 p-6">
      {/* Hero: matches Hashrate Autopilot's green PRICE/DELIVERED panel + status/action panel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-emerald-950/40 border border-emerald-900 rounded-lg p-5 space-y-4">
          <div>
            <div className="text-[11px] tracking-wider text-slate-500 uppercase mb-1">Portfolio NAV</div>
            <div className="text-4xl font-bold text-slate-100">{formatBtcAmount(totalNav, unit)}</div>
          </div>
          {/* BTC capital currently deployed per pair (last actual rebalancing
              result, not a target %) - always sums exactly to Portfolio NAV
              above, since both are derived from the same per-pair NAV data. */}
          <div className="flex flex-wrap gap-8">
            {status.pairs.map((pair) => (
              <div key={pair.pairKey}>
                <div className="text-[11px] tracking-wider text-slate-500 uppercase mb-1">
                  {pair.displayName.split(" ")[0]} deployed
                </div>
                <div className="text-lg font-semibold text-slate-300">
                  {formatBtcAmount(deployedByPair[pair.pairKey] ?? 0, unit)}
                </div>
              </div>
            ))}
          </div>
          <RunModeToggle current={status.runMode} onChange={onModeChange} />
        </div>

        <div className="bg-ink-900 border border-slate-800 rounded-lg p-5 flex flex-col justify-between gap-4">
          <div>
            <p className="text-slate-200 text-sm">{statusHeadline(status)}</p>
            <button
              onClick={onRunNow}
              disabled={runningNow}
              className="mt-3 px-3 py-1.5 rounded text-sm font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50 border border-slate-700"
            >
              {runningNow ? "Running..." : "Run decision now"}
            </button>
          </div>
          <div className="flex justify-between text-xs text-slate-500 font-mono">
            <span>
              last tick: {status.lastTickAt ? new Date(status.lastTickAt).toLocaleString() : "never"}
            </span>
            <span>next in {status.nextTickAt ? formatCountdown(status.nextTickAt - Date.now()) : "-"}</span>
          </div>
        </div>
      </div>

      {/* Real live wallet balances - ground truth from Bitfinex, not the internal NAV ledger */}
      <div className="grid grid-cols-3 gap-3">
        <MetricTile
          label="BTC held (live)"
          value={status.realBtcHeld !== null ? status.realBtcHeld.toFixed(8) : "-"}
        />
        <MetricTile
          label="XAUT held (live)"
          value={status.pairs.find((p) => p.pairKey === "xaut")?.realAssetHeld?.toFixed(6) ?? "-"}
        />
        <MetricTile
          label="XMR held (live)"
          value={status.pairs.find((p) => p.pairKey === "xmr")?.realAssetHeld?.toFixed(6) ?? "-"}
        />
      </div>
      {/* Metric tile row - matches Hashrate Autopilot's UPTIME/POOL LUCK/BLOCK HEIGHT row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {status.pairs.map((pair) => {
          const resizeBlocked = Math.abs(pair.capitalFractionBtc - pair.appliedFractionBtc) > 0.001;
          return (
            <MetricTile
              key={`${pair.pairKey}-alloc`}
              label={`${pair.displayName.split(" ")[0]} allocation`}
              value={`${(pair.appliedFractionBtc * 100).toFixed(0)}%`}
              sublabel={
                resizeBlocked
                  ? pair.currentPosition === "flat"
                    ? `target ${(pair.capitalFractionBtc * 100).toFixed(0)}% blocked - below exchange minimum`
                    : `target ${(pair.capitalFractionBtc * 100).toFixed(0)}% - waiting for own regime to go gold`
                  : (pair.regime ?? "no regime yet")
              }
              valueColor={resizeBlocked ? "text-amber-400" : pair.regime === "orange" ? "text-amber-400" : "text-slate-100"}
            />
          );
        })}
        {status.pairs.map((pair) => (
          <MetricTile
            key={`${pair.pairKey}-pos`}
            label={`${pair.displayName.split(" ")[0]} position`}
            value={pair.currentPosition === "long" ? "BTC" : pair.displayName.split(" ")[0]}
            sublabel={pair.decisionTarget !== pair.currentPosition ? "rotation pending" : "on target"}
          />
        ))}
      </div>

      {/* NAV charts - one per pair, matches Hashrate Autopilot's HASHRATE/PRICE chart sections */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {status.pairs.map((pair) => (
          <LineChart
            key={pair.pairKey}
            title={`${pair.displayName} · NAV`}
            series={[
              {
                label: "BTC-equivalent NAV",
                color: PAIR_COLORS[pair.pairKey] ?? "#34d399",
                points: (navByPair[pair.pairKey] ?? []).map((p) => ({ x: p.timestamp, y: p.btcEquivalentNav })),
              },
            ]}
            valueFormatter={(v) => formatBtcAmount(v, unit)}
          />
        ))}
      </div>

      {/* Per-pair status cards + portfolio PnL - matches Hashrate Autopilot's BRAIINS/DATUM/OCEAN + PROFIT & LOSS row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {status.pairs.map((pair) => (
          <PairPanel
            key={pair.pairKey}
            status={pair}
            navHistory={navByPair[pair.pairKey] ?? []}
            funded={fundedByPair[pair.pairKey] ?? 0}
            unit={unit}
            color={PAIR_COLORS[pair.pairKey] ?? "#34d399"}
          />
        ))}
        <PortfolioPnl status={status} unit={unit} />
      </div>
    </div>
  );
}
