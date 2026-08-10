import type { Trade } from "@autopilot/shared";
import { formatBtcAmount, type DisplayUnit } from "../format.js";

const STATUS_STYLES: Record<Trade["status"], string> = {
  open: "bg-emerald-950 text-emerald-300 border border-emerald-800",
  closed_win: "bg-emerald-950 text-emerald-300 border border-emerald-800",
  closed_loss: "bg-red-950 text-red-300 border border-red-800",
  cancelled: "bg-slate-800 text-slate-400 border border-slate-700",
};

/** Trade log table - matches Hashrate Autopilot's Timeline event log density/style. */
export function PositionsTable({ trades, unit }: { trades: Trade[]; unit: DisplayUnit }) {
  if (trades.length === 0) {
    return <div className="text-sm text-slate-500 py-4">No trades recorded yet.</div>;
  }

  return (
    <table className="w-full text-xs text-left text-slate-300">
      <thead className="text-slate-500 uppercase tracking-wide">
        <tr>
          <th className="py-1.5 pr-3">Opened</th>
          <th className="py-1.5 pr-3">Closed</th>
          <th className="py-1.5 pr-3">Target</th>
          <th className="py-1.5 pr-3">BTC capital</th>
          <th className="py-1.5 pr-3">Realized PnL</th>
          <th className="py-1.5 pr-3">Status</th>
          <th className="py-1.5 pr-3">Notes</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id} className="border-t border-slate-800">
            <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(t.openedAt).toLocaleString()}</td>
            <td className="py-1.5 pr-3 whitespace-nowrap">{t.closedAt ? new Date(t.closedAt).toLocaleString() : "-"}</td>
            <td className="py-1.5 pr-3">{t.targetPosition}</td>
            <td className="py-1.5 pr-3">{formatBtcAmount(t.btcCapitalAtOpen, unit)}</td>
            <td className="py-1.5 pr-3">
              {t.realizedBtcPnl !== undefined ? formatBtcAmount(t.realizedBtcPnl, unit, { signed: true }) : "-"}
            </td>
            <td className="py-1.5 pr-3">
              <span className={`px-1.5 py-0.5 rounded text-[11px] ${STATUS_STYLES[t.status]}`}>{t.status}</span>
            </td>
            <td className="py-1.5 pr-3 text-slate-500">{t.notes ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
