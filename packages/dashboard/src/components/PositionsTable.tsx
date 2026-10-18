import { Fragment } from "react";
import { deriveAssetHolds, type ExecutionLogEntry, type Trade } from "@autopilot/shared";
import { formatBtcAmount, type DisplayUnit } from "../format.js";

function formatReturn(pnl: number | undefined, capital: number): string {
  if (pnl === undefined || capital === 0) return "-";
  const pct = (pnl / capital) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * entryPrice/exitPrice are stored internally in this project's own ratio
 * convention (asset units per 1 BTC - e.g. "169.49 XMR per BTC" - see
 * nav.ts's btcXautRatio), NOT the natural direct pair quote everyone reads
 * on an exchange or TradingView (BTC per 1 unit of asset - e.g. "0.0059
 * BTC/XMR"). Displaying the raw internal number caused real, confirmed
 * confusion trying to cross-check a fill against TradingView/Bitfinex (bug
 * found live Aug 2026, round 5): the numbers weren't wrong, just inverted
 * relative to what a normal price quote looks like. Invert here, for
 * display only - the internal storage/calculation convention is left
 * untouched everywhere else (strategy math, backtest comparisons, etc.),
 * this is purely a presentation fix.
 */
function formatPrice(price: number | undefined): string {
  return price !== undefined && price > 0 ? (1 / price).toFixed(8) : "-";
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
 *
 * That earlier fix wasn't enough on its own (bug found live Aug 2026, round
 * 6): a bootstrap-inferred trade (opened with an estimated price, not a real
 * fill - see loop.ts's reconciliation block) can go on to be legitimately
 * CLOSED by a real flip later, which passes the closed-status filter above
 * and renders as a genuine round trip with a real-looking PnL/return - even
 * though the "entry" leg never actually happened as a trade. Confirmed live:
 * XMR's first-ever real entry (BTC -> XMR) showed up paired against a
 * bootstrap "entry" from days earlier, reporting a fabricated +6.37% return.
 * Exclude any trade whose open was bootstrap-inferred (tagged via `notes`
 * at insert time) from this performance table entirely, regardless of its
 * closed status - it never represents a real trading decision.
 */
/** Actual fill price on top, signal (bar close) price underneath; either may be missing on older rows. */
function PriceCell({ actual, signal }: { actual: number | undefined; signal: number | undefined }) {
  if (actual === undefined && signal === undefined) return <>-</>;
  if (actual === undefined) return <>{formatPrice(signal)}</>;
  return (
    <>
      {formatPrice(actual)}
      <div className="text-[10px] text-slate-500">signal {formatPrice(signal)}</div>
    </>
  );
}

/** Return of the open asset hold so far: asset-per-BTC entry/current - 1 (positive = asset gained vs BTC). */
function unrealizedPct(entry: number | undefined, current: number | null | undefined): number | undefined {
  if (!entry || !current || entry <= 0 || current <= 0) return undefined;
  return (entry / current - 1) * 100;
}

/**
 * Volume-weighted average cost (BTC per asset unit) of every logged buy since the
 * position opened - the entry flip PLUS later top-ups and resizes - using each
 * execution's real fills. Only executions with fill data count, so `amount` says
 * how much of the position the average is based on.
 */
function positionCost(
  executions: ExecutionLogEntry[] | undefined,
  entryAt: number | undefined
): { avgBtc: number; amount: number; buys: number } | undefined {
  if (!executions || entryAt === undefined) return undefined;
  let amount = 0;
  let cost = 0;
  let buys = 0;
  for (const e of executions) {
    if (e.side !== "sell_btc_for_xaut" || e.status !== "executed" || e.timestamp < entryAt - 120_000) continue;
    if (!e.assetAmount || !e.avgPriceBtc) continue;
    amount += e.assetAmount;
    cost += e.assetAmount * e.avgPriceBtc;
    buys += e.orderCount ?? 1;
  }
  return amount > 0 ? { avgBtc: cost / amount, amount, buys } : undefined;
}

const fmtPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;

export function PositionsTable({
  trades,
  unit,
  currentRatio,
  executions,
  assetLabel,
  heldAsset,
}: {
  trades: Trade[];
  unit: DisplayUnit;
  /** This pair's executions, used to derive the open position's average cost across all buys. */
  executions?: ExecutionLogEntry[];
  assetLabel?: string;
  /** Live wallet balance of the asset, to show how much of the position the average cost covers. */
  heldAsset?: number | null;
  /** Latest asset-per-BTC ratio, for the open trade's unrealized return. */
  currentRatio?: number | null;
}) {
  const holds = deriveAssetHolds(trades);
  if (holds.length === 0) {
    return <div className="text-sm text-slate-500 py-4">No trades yet.</div>;
  }
  const ordered = [...holds].reverse(); // most recent first, matches the reference
  const closed = holds.filter((h) => h.pnl !== undefined);
  const wins = closed.filter((h) => (h.pnl ?? 0) >= 0).length;
  const totalNetPnl = closed.reduce((sum, h) => sum + (h.pnl ?? 0), 0);
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

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
            const pnlColor = t.pnl === undefined ? "" : t.pnl >= 0 ? "text-emerald-400" : "text-red-400";
            const isOpen = t.exitAt === undefined && t.entryAt !== undefined;
            const uActual = isOpen ? unrealizedPct(t.actualEntryPrice, currentRatio) : undefined;
            const uSignal = isOpen ? unrealizedPct(t.entryPrice, currentRatio) : undefined;
            const cost = isOpen ? positionCost(executions, t.entryAt) : undefined;
            const uAvg = cost && currentRatio && currentRatio > 0 ? (1 / currentRatio / cost.avgBtc - 1) * 100 : undefined;
            const u = uAvg ?? uActual ?? uSignal;
            const uColor = u === undefined ? "" : u >= 0 ? "text-emerald-400" : "text-red-400";
            const sizeCell = t.size !== undefined ? formatBtcAmount(t.size, unit) : "-";

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
                    {t.exitAt !== undefined ? new Date(t.exitAt).toLocaleDateString() : "Open"}
                  </td>
                  <td className="py-1.5 pr-3">
                    {isOpen && currentRatio ? (
                      <span className="text-slate-500">now {formatPrice(currentRatio)}</span>
                    ) : (
                      <PriceCell actual={t.actualExitPrice} signal={t.exitPrice} />
                    )}
                  </td>
                  <td className="py-1.5 pr-3">{sizeCell}</td>
                  <td rowSpan={2} className={`py-1.5 pr-3 align-top ${pnlColor}`}>
                    {t.pnl !== undefined ? formatBtcAmount(t.pnl, unit, { signed: true }) : "-"}
                    {t.pnl !== undefined && t.pnlBasis === "actual" && t.signalPnl !== undefined && (
                      <div className="text-[10px] text-slate-500">signal {formatBtcAmount(t.signalPnl, unit, { signed: true })}</div>
                    )}
                    {t.pnl !== undefined && t.pnlBasis === "signal" && (
                      <div className="text-[10px] text-slate-500">signal prices only</div>
                    )}
                  </td>
                  <td rowSpan={2} className={`py-1.5 pr-3 align-top ${t.pnl !== undefined ? pnlColor : uColor}`}>
                    {t.pnl !== undefined ? (
                      formatReturn(t.pnl, t.size ?? 0)
                    ) : u !== undefined ? (
                      <>
                        {fmtPct(u)}
                        <div className="text-[10px] text-slate-500">
                          unrealized{uAvg !== undefined ? " vs avg cost" : ""}
                          {uSignal !== undefined && uAvg !== undefined ? ` (signal entry ${fmtPct(uSignal)})` : uActual !== undefined && uSignal !== undefined ? ` (signal ${fmtPct(uSignal)})` : ""}
                        </div>
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
                <tr className="border-b border-slate-800">
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span className="text-slate-500 mr-1">Entry</span>
                    {t.entryAt !== undefined ? new Date(t.entryAt).toLocaleDateString() : "-"}
                  </td>
                  <td className="py-1.5 pr-3">
                    <PriceCell actual={t.actualEntryPrice} signal={t.entryPrice} />
                    {cost && (
                      <div className="text-[10px] text-sky-300/80">
                        avg cost {cost.avgBtc.toFixed(8)} ({cost.buys} buys, {cost.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {assetLabel ?? "asset"}{heldAsset ? `, ${((cost.amount / heldAsset) * 100).toFixed(0)}% of ${heldAsset.toLocaleString(undefined, { maximumFractionDigits: 2 })} held` : ""})
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">{sizeCell}</td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
