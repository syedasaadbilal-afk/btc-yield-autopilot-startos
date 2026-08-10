import type { DecisionRow } from "../api.js";

const REGIME_STYLES: Record<DecisionRow["regime"], string> = {
  navy: "bg-sky-950 text-sky-300 border border-sky-800",
  orange: "bg-amber-950 text-amber-300 border border-amber-800",
  gray: "bg-slate-800 text-slate-300 border border-slate-700",
};

export function DecisionHistory({ rows }: { rows: DecisionRow[] }) {
  if (rows.length === 0) {
    return <div className="text-sm text-slate-500 py-4">No decisions recorded yet.</div>;
  }

  return (
    <table className="w-full text-xs text-left text-slate-300">
      <thead className="text-slate-500 uppercase tracking-wide">
        <tr>
          <th className="py-1.5 pr-3">Time</th>
          <th className="py-1.5 pr-3">Regime</th>
          <th className="py-1.5 pr-3">Position</th>
          <th className="py-1.5 pr-3">Switched</th>
          <th className="py-1.5 pr-3">Dist from baseline</th>
          <th className="py-1.5 pr-3">Reason</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.timestamp} className="border-t border-slate-800">
            <td className="py-1.5 pr-3 whitespace-nowrap">{new Date(row.timestamp).toLocaleString()}</td>
            <td className="py-1.5 pr-3">
              <span className={`px-1.5 py-0.5 rounded text-[11px] ${REGIME_STYLES[row.regime]}`}>{row.regime}</span>
            </td>
            <td className="py-1.5 pr-3">{row.position}</td>
            <td className="py-1.5 pr-3">{row.switched ? <span className="text-amber-400">yes</span> : ""}</td>
            <td className="py-1.5 pr-3">{(row.distFromBaseline * 100).toFixed(2)}%</td>
            <td className="py-1.5 pr-3 text-slate-500">{row.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
