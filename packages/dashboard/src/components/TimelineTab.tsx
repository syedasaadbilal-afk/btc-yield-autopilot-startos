import { useEffect, useState } from "react";
import type { ExecutionLogEntry, Trade } from "@autopilot/shared";
import { fetchExecutions, fetchHistory, fetchTrades, type DecisionRow, type StatusResponse } from "../api.js";
import type { DisplayUnit } from "../format.js";
import { DecisionHistory } from "./DecisionHistory.js";
import { ExecutionsTable } from "./ExecutionsTable.js";
import { PositionsTable } from "./PositionsTable.js";

/** Timeline tab: per-pair execution log + trade PnL + regime decision history, matching Hashrate Autopilot's Timeline tab. */
export function TimelineTab({ status, unit }: { status: StatusResponse | undefined; unit: DisplayUnit }) {
  const [selectedPair, setSelectedPair] = useState<string | undefined>(undefined);
  const [executions, setExecutions] = useState<ExecutionLogEntry[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);

  const pairKey = selectedPair ?? status?.pairs[0]?.pairKey;

  useEffect(() => {
    if (!pairKey) return;
    let cancelled = false;
    async function load() {
      const [ex, t, d] = await Promise.all([
        fetchExecutions(pairKey!, 100),
        fetchTrades(pairKey!, 100),
        fetchHistory(pairKey!, 100),
      ]);
      if (!cancelled) {
        setExecutions(ex);
        setTrades(t);
        setDecisions(d);
      }
    }
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pairKey]);

  if (!status) {
    return <div className="text-slate-500 p-6">Loading...</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-2">
        {status.pairs.map((pair) => (
          <button
            key={pair.pairKey}
            onClick={() => setSelectedPair(pair.pairKey)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
              pairKey === pair.pairKey
                ? "bg-amber-400/10 border-amber-800 text-amber-400"
                : "border-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            {pair.displayName}
          </button>
        ))}
      </div>

      <div className="bg-ink-900 border border-slate-800 rounded-lg p-4">
        <h3 className="text-xs font-semibold tracking-wider text-slate-300 uppercase mb-3">
          Executions (resizes, USDT-leg trades, entries/exits)
        </h3>
        <div className="overflow-x-auto">
          <ExecutionsTable executions={executions} unit={unit} />
        </div>
      </div>

      <div className="bg-ink-900 border border-slate-800 rounded-lg p-4">
        <h3 className="text-xs font-semibold tracking-wider text-slate-300 uppercase mb-3">
          Trades (closed entry/exit round trips only)
        </h3>
        <div className="overflow-x-auto">
          <PositionsTable trades={trades} unit={unit} />
        </div>
      </div>

      <div className="bg-ink-900 border border-slate-800 rounded-lg p-4">
        <h3 className="text-xs font-semibold tracking-wider text-slate-300 uppercase mb-3">Regime decisions</h3>
        <div className="overflow-x-auto">
          <DecisionHistory rows={decisions} />
        </div>
      </div>
    </div>
  );
}
