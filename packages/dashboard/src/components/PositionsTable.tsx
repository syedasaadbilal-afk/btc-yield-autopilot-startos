import { Fragment } from "react";
import type { Trade } from "@autopilot/shared";
import { formatBtcAmount, type DisplayUnit } from "../format.js";

function formatReturn(pnl: number | undefined, capital: number): string {
  if (pnl === undefined || capital === 0) return "-";
  const pct = (pnl / capital) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function formatPrice(price: number | undefined): string {
  return price !== undefined ? price.toFixed(6) : "-";
}

/**
 * TradingView "List of trades" style report (explicit user spec, matched
 * against their screenshot): each CLOSED round-trip trade renders as two
 * stacked rows - Exit on top, Entry below, same order TradingView uses -
 * sharing one Trade#/Type/Net PnL/Return via rowSpan. The columns are
 * exactly Trade #, Type, Date and time, Price, Size, Net PnL, Return - no
 * extra columns, to match the reference format precisely.
 *
 * Only CLOSED round-trip trades are shown (bug found live Aug 2026): this
 * used to also render a single row for still-open/cancelled trades, which
 * meant a leftover bootstrap-inferred row (the daemon's first-ever
 * reconciliation with the real wallet, not a real trade) showed up looking
 * like "XMR entered" when XMR has never actually entered Monero. TradingView's
 * own List of Trades only ever lists closed trades for the same reason - an
 * open position has no exit price/PnL to report yet.
 */
export function PositionsTable({ trades, unit }: { trades: Trade[]; unit: DisplayUnit }) {
  const closed = trades.filter((t) => t.status === "closed_win" || t.status === "closed_loss");
  if (closed.length === 0) {
    return <div className="text-sm text-slate-500 py-4">No closed trades yet.</div>;
  }
  const ordered = [...closed].reverse(); // most recent trade first, matches the reference
  const wins = closed.filter((t) => t.status === "closed_win").length;
  const totalNetPnl = closed.reduce((sum, t) => sum + (t.realizedBtcPnl ?? 0), 0);
  const winRate = (wins / closed.length) * 100;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-6 text-xs text-slate-400 border-b border-slate-800 pb-3">
        <span>
          Closed trades: <span className="text-slate-200 font-medium">{closed.length}</span>
        </span>
        <span>
          Win rate: <span className="text-slate-200 font-medium">{winRate.toFixed(0)}%</span>
        </span>
        <span>
          Net PnL:{" "}
          <span className={`font-medium ${totalNetPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {formatBtcAmount(totalNetPnl, unit, { signed: true })}
          </span>
        </span>
      </div>
      <table className="w-full text-xs text-left text-slate-300">
        <thead className="text-slate-500 uppercase tracking-wide">
          <tr>
            <th className="py-1.5 pr-3">Trade #</th>
            <th className="py-1.5 pr-3">Type</th>
            <th className="py-1.5 pr-3">Date and time</th>
            <th className="py-1.5 pr-3">Price</th>
            <th className="py-1.5 pr-3">Size</th>
            <th className="py-1.5 pr-3">Net PnL</th>
            <th className="py-1.5 pr-3">Return</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((t, i) => {
            const tradeNumber = ordered.length - i;
            const pnlColor =
              t.realizedBtcPnl === undefined ? "" : t.realizedBtcPnl >= 0 ? "text-emerald-400" : "text-red-400";

            return (
              <Fragment key={t.id}>
                <tr className="border-t border-slate-800">
                  <td rowSpan={2} className="py-1.5 pr-3 text-slate-500 align-top">
                    {tradeNumber}
                  </td>
                  <td rowSpan={2} className="py-1.5 pr-3 text-sky-400 align-top">
                    long
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span className="text-slate-500 mr-1">Exit</span>
                    {t.closedAt ? new Date(t.closedAt).toLocaleDateString() : "-"}
                  </td>
                  <td className="py-1.5 pr-3">{formatPrice(t.exitPrice)}</td>
                  <td className="py-1.5 pr-3">{formatBtcAmount(t.btcCapitalAtOpen, unit)}</td>
                  <td rowSpan={2} className={`py-1.5 pr-3 align-top ${pnlColor}`}>
                    {t.realizedBtcPnl !== undefined ? formatBtcAmount(t.realizedBtcPnl, unit, { signed: true }) : "-"}
                  </td>
                  <td rowSpan={2} className={`py-1.5 pr-3 align-top ${pnlColor}`}>
                    {formatReturn(t.realizedBtcPnl, t.btcCapitalAtOpen)}
                  </td>
                </tr>
                <tr className="border-b border-slate-800">
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span className="text-slate-500 mr-1">Entry</span>
                    {new Date(t.openedAt).toLocaleDateString()}
                  </td>
                  <td className="py-1.5 pr-3">{formatPrice(t.entryPrice)}</td>
                  <td className="py-1.5 pr-3">{formatBtcAmount(t.btcCapitalAtOpen, unit)}</td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
