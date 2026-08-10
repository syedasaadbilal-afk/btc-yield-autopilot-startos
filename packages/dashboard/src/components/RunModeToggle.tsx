import { RUN_MODES, type RunMode } from "@autopilot/shared";

// Hashrate Autopilot's DRY RUN / LIVE / PAUSED segmented control: active
// mode gets a solid highlight (amber for LIVE, matching its "this is the
// mode that moves real money" emphasis), everything else stays flat/dark.
const ACTIVE_STYLES: Record<RunMode, string> = {
  DRY_RUN: "bg-slate-200 text-ink-950",
  PAPER: "bg-sky-400 text-ink-950",
  LIVE: "bg-amber-400 text-ink-950",
  PAUSED: "bg-slate-500 text-ink-950",
};

export function RunModeToggle({
  current,
  onChange,
}: {
  current: RunMode;
  onChange: (mode: RunMode) => void;
}) {
  return (
    <div className="flex gap-1 bg-ink-950/60 p-1 rounded-lg border border-slate-800 w-fit">
      {RUN_MODES.map((mode) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          className={`px-4 py-2 rounded-md text-sm font-semibold tracking-wide transition-colors ${
            mode === current ? ACTIVE_STYLES[mode] : "text-slate-500 hover:text-slate-200"
          }`}
        >
          {mode.replace("_", " ")}
        </button>
      ))}
    </div>
  );
}
