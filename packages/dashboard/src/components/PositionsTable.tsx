import type { Trade } from "@autopilot/shared";
import { formatBtcAmount, type DisplayUnit } from "../format.js";

const STATUS_STYLES: Record<Trade["status"], string> = {
  open: "bg-emerald-950 text-emerald-300 border border-emerald-800",
  closed_win: "bg-emerald-950 text-emerald-300 border border-emerald-800",
  closed_loss: "bg-red-950 text-red-300 border border-red-800",
  cancelled: "bg-slate-800 text-slate-400 border border-slate-700",
};

function formatReturn(pnl: number | undefined, capital: number): string {
  if (pnl === undefined || capital === 0) return "-";
  const pct = (pnl / capital) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** Trade log table - matches Hashrate Autopilot's Timeline event log density/style, plus a
 * TradingView-style summary row (total trades, win rate, net PnL) and per-trade Return %. */
export function PositionsTable({ trades, unit }: { trades: Trade[]; unit: DisplayUnit }) {
  if (trades.length === 0) {
    return <div className="text-sm text-slate-500 py-4">No trades recorded yet.</div>;
  }
  const ordered = [...trades].reverse();
  const closed = trades.filter((t) => t.status === "closed_win" || t.status === "closed_loss");
  const wins = trades.filter((t) => t.status === "closed_win").length;
  const totalNetPnl = closed.reduce((sum, t) => sum + (t.realizedBtcPnl ?? 0), 0);
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : null;

  return (
    <div className="space-y-3">
      {closed.length > 0 && (
        <div className="flex flex-wrap gap-6 text-xs text-slate-400 border-b border-slate-800 pb-3">
          <span>
            Closed trades: <span className="text-slate-200 font-medium">{closed.length}</span>
          </span>
          <span>
            Win rate: <span className="text-slate-200 font-medium">{winRate!.toFixed(0)}%</span>
          </span>
          <span>
            Net PnL:{" "}
            <span className={`font-medium ${totalNetPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {formatBtcAmount(totalNetPnl, unit, { signed: true })}
            </span>
          </span>
        </div>
      )}
      <table className="w-full text-xs text-left text-slate-300">
        <thead className="text-slate-500 uppercase tracking-wide">
          <tr>
            <th className="py-1.5 pr-3">#</th>
            <th className="py-1.5 pr-3">Opened</th>
            <th className="py-1.5 pr-3">Closed</th>
            <th className="py-1.5 pr-3">Target</th>
            <th className="py-1.5 pr-3">BTC capital</th>
            <th className="py-1.5 pr-3">Realized PnL</th>
            <th className="py-1.5 pr-3">Return</th>
            <th className="py-1.5 pr-3">Status</th>
            <th className="py-1.5 pr-3">Notes</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((t, i) => (
            <tr key={t.id} className="border-t border-slate-800">
              <td className="py-1.5 pr-3 text-slate-500">{i + 1}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(t.openedAt).toLocaleString()}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">
                {t.closedAt ? new Date(t.closedAt).toLocaleString() : "-"}
              </td>
              <td className="py-1.5 pr-3">{t.targetPosition}</td>
              <td className="py-1.5 pr-3">{formatBtcAmount(t.btcCapitalAtOpen, unit)}</td>
              <td className="py-1.5 pr-3">
                {t.realizedBtcPnl !== undefined ? formatBtcAmount(t.realizedBtcPnl, unit, { signed: true }) : "-"}
              </td>
              <td
                className={`py-1.5 pr-3 ${
                  t.realizedBtcPnl === undefined ? "" : t.realizedBtcPnl >= 0 ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {formatReturn(t.realizedBtcPnl, t.btcCapitalAtOpen)}
              </td>
              <td className="py-1.5 pr-3">
                <span className={`px-1.5 py-0.5 rounded text-[11px] ${STATUS_STYLES[t.status]}`}>{t.status}</span>
              </td>
              <td className="py-1.5 pr-3 text-slate-500">{t.notes ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
