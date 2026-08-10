import type { DisplayUnit } from "../format.js";

export type TabKey = "status" | "timeline" | "config";

const TABS: { key: TabKey; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "timeline", label: "Timeline" },
  { key: "config", label: "Config" },
];

/** Top nav bar, matching Hashrate Autopilot's layout: logo+name, tabs, unit toggle. */
export function TopNav({
  active,
  onChange,
  unit,
  onUnitChange,
}: {
  active: TabKey;
  onChange: (tab: TabKey) => void;
  unit: DisplayUnit;
  onUnitChange: (unit: DisplayUnit) => void;
}) {
  return (
    <nav className="flex flex-wrap items-center justify-between gap-4 bg-ink-900 border-b border-slate-800 px-6 py-3">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-xl" aria-hidden>
            🪙
          </span>
          <span className="font-semibold text-slate-100 tracking-wide">BTC Yield Autopilot</span>
        </div>
        <div className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => onChange(tab.key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                active === tab.key
                  ? "text-amber-400 bg-amber-400/10"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1 bg-ink-950/60 p-1 rounded-lg border border-slate-800">
        {(["sats", "btc"] as DisplayUnit[]).map((u) => (
          <button
            key={u}
            onClick={() => onUnitChange(u)}
            className={`px-3 py-1 rounded-md text-xs font-semibold uppercase tracking-wide transition-colors ${
              unit === u ? "bg-amber-400 text-ink-950" : "text-slate-500 hover:text-slate-200"
            }`}
          >
            {u === "sats" ? "sats" : "BTC"}
          </button>
        ))}
      </div>
    </nav>
  );
}
