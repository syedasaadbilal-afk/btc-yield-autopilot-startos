import type { NavPoint, RunMode } from "@autopilot/shared";
import type { StatusResponse } from "../api.js";
import { formatBtcAmount, formatCountdown, formatPercent, type DisplayUnit } from "../format.js";
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
    return `All pairs gold (${gold.map((p) => p.displayName.split(" ")[0]).join(", ")}) - split evenly.`;
  }
  return `${gold.map((p) => p.displayName.split(" ")[0]).join(", ")} gold, ${others
    .map((p) => p.displayName.split(" ")[0])
    .join(", ")} blue/gray - full allocation to the gold pair.`;
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

  let totalNav = 0;
  const totalFunded = status.startingBtc;
  for (const pair of status.pairs) {
    const funded = status.startingBtc * pair.capitalFractionBtc;
    const hist = navByPair[pair.pairKey] ?? [];
    totalNav += hist.length > 0 ? hist[hist.length - 1]!.btcEquivalentNav : funded;
  }
  const portfolioPnl = totalNav - totalFunded;
  const portfolioYield = totalFunded > 0 ? portfolioPnl / totalFunded : 0;

  return (
    <div className="space-y-6 p-6">
      {/* Hero: matches Hashrate Autopilot's green PRICE/DELIVERED panel + status/action panel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-emerald-950/40 border border-emerald-900 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap gap-8">
            <div>
              <div className="text-[11px] tracking-wider text-slate-500 uppercase mb-1">Portfolio NAV</div>
              <div className="text-4xl font-bold text-slate-100">{formatBtcAmount(totalNav, unit)}</div>
              <div className={`text-sm font-semibold mt-1 ${portfolioPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {formatPercent(portfolioYield)} ({formatBtcAmount(portfolioPnl, unit, { signed: true })})
              </div>
            </div>
            <div>
              <div className="text-[11px] tracking-wider text-slate-500 uppercase mb-1">Funded</div>
              <div className="text-2xl font-semibold text-slate-300">{formatBtcAmount(totalFunded, unit)}</div>
            </div>
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
        {status.pairs.map((pair) => (
          <MetricTile
            key={`${pair.pairKey}-alloc`}
            label={`${pair.displayName.split(" ")[0]} allocation`}
            value={`${(pair.capitalFractionBtc * 100).toFixed(0)}%`}
            sublabel={pair.regime ?? "no regime yet"}
            valueColor={pair.regime === "orange" ? "text-amber-400" : "text-slate-100"}
          />
        ))}
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
            totalStartingBtc={status.startingBtc}
            unit={unit}
            color={PAIR_COLORS[pair.pairKey] ?? "#34d399"}
          />
        ))}
        <PortfolioPnl status={status} navByPair={navByPair} unit={unit} />
      </div>
    </div>
  );
}
