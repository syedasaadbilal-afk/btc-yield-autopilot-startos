/** A single stat tile, matching Hashrate Autopilot's UPTIME/POOL LUCK/BLOCK HEIGHT tile row. */
export function MetricTile({
  label,
  value,
  sublabel,
  valueColor = "text-slate-100",
}: {
  label: string;
  value: string;
  sublabel?: string;
  valueColor?: string;
}) {
  return (
    <div className="bg-ink-900 border border-slate-800 rounded-lg px-4 py-3 flex flex-col gap-1 min-w-0">
      <span className="text-[11px] tracking-wider text-slate-500 uppercase truncate">{label}</span>
      <span className={`text-2xl font-semibold ${valueColor} truncate`}>{value}</span>
      {sublabel && <span className="text-xs text-slate-500">{sublabel}</span>}
    </div>
  );
}
