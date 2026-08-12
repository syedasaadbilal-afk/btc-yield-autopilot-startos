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
  funded,
  unit,
  color,
}: {
  status: PairStatus;
  navHistory: NavPoint[];
  /** This pair's funded/cost-basis baseline (StatusTab's pairFundedBtc: first-ever NAV point, not a live-recomputed fraction - see #95/#101). */
  funded: number;
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
  const isRebalancing = status.decisionTarget !== status.currentPosition;
  const resizeBlocked = Math.abs(status.capitalFractionBtc - status.appliedFractionBtc) > 0.001;
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
        <Row label="allocation" value={`${(status.appliedFractionBtc * 100).toFixed(0)}%`} />
        {resizeBlocked && (
          <Row
            label=""
            // "below exchange minimum" is only the real reason when this pair
            // is currently flat (holding its own asset) - a resize was
            // genuinely attempted and every tranche failed the minimum. When
            // the pair is "long" (BTC), the override's target simply can't
            // apply yet - it only sizes a pair once its OWN regime lets it
            // hold the asset at all - so no resize was ever attempted. Bug
            // found live Aug 2026: this used to show the "below exchange
            // minimum" text unconditionally, which was actively misleading
            // for a pair like XMR that just hasn't gone gold yet.
            value={
              status.currentPosition === "flat"
                ? `target ${(status.capitalFractionBtc * 100).toFixed(0)}% blocked - below exchange minimum order size`
                : `target ${(status.capitalFractionBtc * 100).toFixed(0)}% - waiting for ${status.displayName.split(" ")[0]}'s own regime to go gold`
            }
            valueClass="text-amber-400 text-xs"
          />
        )}
        <Row label="funded" value={formatBtcAmount(funded, unit)} />
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
        <NavChart navHistory={navHistory} startingBtc={funded} unit={unit} color={color} compact />
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
