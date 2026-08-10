import { useState } from "react";

export interface ChartSeries {
  label: string;
  color: string;
  points: { x: number; y: number }[]; // x = timestamp, y = value
}

/**
 * Dark-card line chart matching Hashrate Autopilot's HASHRATE/PRICE chart
 * sections: card header with title + legend + EXPAND toggle, gridlines, and
 * one colored polyline per series (plain SVG - no charting dependency).
 */
export function LineChart({
  title,
  series,
  valueFormatter,
  compactHeight = 96,
  expandedHeight = 220,
}: {
  title: string;
  series: ChartSeries[];
  valueFormatter?: (v: number) => string;
  compactHeight?: number;
  expandedHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const width = 640;
  const height = expanded ? expandedHeight : compactHeight;

  const allPoints = series.flatMap((s) => s.points);
  const hasData = allPoints.length > 1;

  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  function toPolyline(points: { x: number; y: number }[]): string {
    return points
      .map((p) => {
        const px = ((p.x - minX) / rangeX) * width;
        const py = height - ((p.y - minY) / rangeY) * height;
        return `${px.toFixed(1)},${py.toFixed(1)}`;
      })
      .join(" ");
  }

  return (
    <div className="bg-ink-900 border border-slate-800 rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <h3 className="text-xs font-semibold tracking-wider text-slate-300 uppercase">{title}</h3>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-[10px] px-2 py-0.5 rounded border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500"
          >
            {expanded ? "COLLAPSE" : "EXPAND"}
          </button>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {series.map((s) => (
            <span key={s.label} className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="inline-block w-2.5 h-0.5" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      {!hasData ? (
        <div className="text-sm text-slate-500 py-6 text-center">No history yet.</div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full bg-ink-950 rounded" style={{ height }}>
          {[0.25, 0.5, 0.75].map((frac) => (
            <line
              key={frac}
              x1={0}
              x2={width}
              y1={height * frac}
              y2={height * frac}
              stroke="#1e293b"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          ))}
          {series.map((s) => (
            <polyline key={s.label} fill="none" stroke={s.color} strokeWidth={2} points={toPolyline(s.points)} />
          ))}
        </svg>
      )}

      {hasData && valueFormatter && (
        <div className="flex justify-between text-[10px] text-slate-600 mt-1">
          <span>{valueFormatter(minY)}</span>
          <span>{valueFormatter(maxY)}</span>
        </div>
      )}
    </div>
  );
}
