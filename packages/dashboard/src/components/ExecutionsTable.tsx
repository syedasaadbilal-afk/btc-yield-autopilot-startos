import type { ExecutionLogEntry } from "@autopilot/shared";
import { formatBtcAmount, type DisplayUnit } from "../format.js";

const KIND_LABELS: Record<ExecutionLogEntry["kind"], string> = {
  flip_entry: "Entry (BTC → asset)",
  flip_exit: "Exit (asset → BTC)",
  resize: "Resize",
  topup: "Idle top-up",
};

const STATUS_STYLES: Record<ExecutionLogEntry["status"], string> = {
  executed: "bg-emerald-950 text-emerald-300 border border-emerald-800",
  blocked: "bg-amber-950 text-amber-300 border border-amber-800",
};

const fmtNum = (n: number, d: number) => n.toLocaleString(undefined, { maximumFractionDigits: d });

/** "10 orders × ~$2,000 bought 125 XMR @ avg $320.5" - or null for rows without fill data. */
function orderSummary(e: ExecutionLogEntry): string | null {
  if (!e.orderCount || !e.assetAmount || !e.quoteUsd || !e.avgPrice) return null;
  const asset = e.pairKey.split("-").pop()?.toUpperCase() ?? "asset";
  const verb = e.side === "sell_btc_for_xaut" ? "bought" : "sold";
  const per = e.quoteUsd / e.orderCount;
  const priceDigits = e.avgPrice >= 100 ? 2 : e.avgPrice >= 1 ? 3 : 6;
  return `${e.orderCount} × ~$${fmtNum(per, 0)} orders ${verb} ${fmtNum(e.assetAmount, 4)} ${asset} (avg $${fmtNum(e.avgPrice, priceDigits)}${e.avgPriceBtc ? ` = ${e.avgPriceBtc.toFixed(8)} BTC` : ""}, total $${fmtNum(e.quoteUsd, 0)})`;
}

/**
 * Every real execution attempt for a pair - flip entry/exit, cross-pair
 * resizes, idle top-ups - distinct from the Status tab's PositionsTable,
 * which only shows closed round-trip trade PnL. This is where a resize like
 * "XAUT 40% -> 0%" actually shows up, even though it never creates/closes a
 * `trades` row (explicit user direction, Aug 2026).
 */
export function ExecutionsTable({ executions, unit }: { executions: ExecutionLogEntry[]; unit: DisplayUnit }) {
  if (executions.length === 0) {
    return <div className="text-sm text-slate-500 py-4">No executions recorded yet.</div>;
  }
  return (
    <table className="w-full text-xs text-left text-slate-300">
      <thead className="text-slate-500 uppercase tracking-wide">
        <tr>
          <th className="py-1.5 pr-3">Time</th>
          <th className="py-1.5 pr-3">Action</th>
          <th className="py-1.5 pr-3">Side</th>
          <th className="py-1.5 pr-3">Requested</th>
          <th className="py-1.5 pr-3">Moved</th>
          <th className="py-1.5 pr-3">Orders</th>
          <th className="py-1.5 pr-3">Status</th>
        </tr>
      </thead>
      <tbody>
        {executions.map((e) => (
          <tr key={e.id} className="border-t border-slate-800">
            <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(e.timestamp).toLocaleString()}</td>
            <td className="py-1.5 pr-3">{KIND_LABELS[e.kind]}</td>
            <td className="py-1.5 pr-3 text-slate-400">{e.side === "sell_btc_for_xaut" ? "BTC → asset" : "asset → BTC"}</td>
            <td className="py-1.5 pr-3">{formatBtcAmount(e.requestedBtc, unit)}</td>
            <td className="py-1.5 pr-3">{formatBtcAmount(e.movedBtc, unit)}</td>
            <td className="py-1.5 pr-3 text-slate-500">{orderSummary(e) ?? (e.routes || "-")}</td>
            <td className="py-1.5 pr-3">
              <span className={`px-1.5 py-0.5 rounded text-[11px] ${STATUS_STYLES[e.status]}`}>{e.status}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
