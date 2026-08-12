import { useEffect, useState } from "react";
import type { NavPoint, Trade } from "@autopilot/shared";
import type { PairStatus } from "../api.js";
import { fetchTrades } from "../api.js";
import { formatBtcAmount, type DisplayUnit } from "../format.js";
import { NavChart } from "./NavChart.js";
import { PositionsTable } from "./PositionsTable.js";

const REGIME_STYLES: Record<string, string> = {
  navy: "bg-sky-950 text-sky-300 border border-sky-800",
  orange: "bg-amber-950 text-amber-300 border border-amber-800",
  gray: "bg-slate-800 text-slate-300 border border-slate-700",
};
const REGIME_LABEL: Record<string, string> = {
  navy: "navy - BTC strong",
  orange: "gold - rotation asset strong",
  gray: "gray - transition",
};

function Row({ label, value, valueClass = "text-slate-200" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-baseline justify-between text-sm py-0.5">
      <span className="text-slate-500">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}

/** One pair's status card - mirrors Hashrate Autopilot's BRAIINS/DATUM/OCEAN source panels. */
export function PairPanel({
  status,
  navHistory,
  totalStartingBtc,
  unit,
  color,
}: {
  status: PairStatus;
  navHistory: NavPoint[];
  /** Daemon-wide funded capital (StatusResponse.startingBtc); scaled by capitalFractionBtc for this pair's yield/PnL baseline. */
  totalStartingBtc: number;
  unit: DisplayUnit;
  color: string;
}) {
  const [trades, setTrades] = useState<Trade[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const t = await fetchTrades(status.pairKey, 5);
      if (!cancelled) setTrades(t);
    }
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status.pairKey]);

  const heldAsset = status.currentPosition === "long" ? "BTC" : status.displayName.split(" ")[0];
  const decisionTargetLabel = status.decisionTarget === "long" ? "BTC" : status.displayName.split(" ")[0];
  const pairStartingBtc = totalStartingBtc * status.capitalFractionBtc;
  const isRebalancing = status.decisionTarget !== status.currentPosition;
  return (
    <section className="bg-ink-900 border border-slate-800 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-100 tracking-wide">{status.displayName.toUpperCase()}</h2>
        {status.regime && (
          <span className={`text-[11px] px-2 py-0.5 rounded ${REGIME_STYLES[status.regime] ?? ""}`}>
            {REGIME_LABEL[status.regime] ?? status.regime}
          </span>
        )}
      </div>
      <div className="border-t border-slate-800 pt-2">
        <Row label="allocation" value={`${(status.capitalFractionBtc * 100).toFixed(0)}%`} />
        <Row label="funded" value={formatBtcAmount(pairStartingBtc, unit)} />
        <Row label="holding" value={heldAsset} />
        {status.distFromBaseline !== null && (
          <Row label="dist from baseline" value={`${(status.distFromBaseline * 100).toFixed(2)}%`} />
        )}
        <Row
          label="decision target"
          value={decisionTargetLabel}
          valueClass={isRebalancing ? "text-amber-400" : "text-slate-200"}
        />
        {isRebalancing && (
          <Row
            label=""
            value={status.gateAllowed ? "rotation pending next tick" : `blocked - ${status.gateReason}`}
            valueClass="text-amber-400 text-xs"
          />
        )}
        {status.error && <Row label="last tick error" value={status.error} valueClass="text-red-400 text-xs" />}
      </div>
      {status.reason && <p className="text-xs text-slate-500 italic border-t border-slate-800 pt-2">"{status.reason}"</p>}
      <div className="border-t border-slate-800 pt-3">
        <NavChart navHistory={navHistory} startingBtc={pairStartingBtc} unit={unit} color={color} compact />
      </div>
      <div className="border-t border-slate-800 pt-3">
        <h3 className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase mb-2">Recent trades</h3>
        <div className="overflow-x-auto">
          <PositionsTable trades={trades} unit={unit} />
        </div>
      </div>
    </section>
  );
}
