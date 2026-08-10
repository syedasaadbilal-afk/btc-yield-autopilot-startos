import { useEffect, useState } from "react";
import type { NavPoint, RunMode } from "@autopilot/shared";
import { fetchNavHistory, fetchStatus, runNow, setRunMode, type StatusResponse } from "./api.js";
import type { DisplayUnit } from "./format.js";
import { TopNav, type TabKey } from "./components/TopNav.js";
import { StatusTab } from "./components/StatusTab.js";
import { TimelineTab } from "./components/TimelineTab.js";
import { ConfigTab } from "./components/ConfigTab.js";

export default function App() {
  const [tab, setTab] = useState<TabKey>("status");
  const [unit, setUnit] = useState<DisplayUnit>("btc");
  const [status, setStatus] = useState<StatusResponse | undefined>(undefined);
  const [navByPair, setNavByPair] = useState<Record<string, NavPoint[]>>({});
  const [runningNow, setRunningNow] = useState(false);

  async function reload() {
    const s = await fetchStatus();
    if (!s) return;
    setStatus(s);

    const navEntries = await Promise.all(s.pairs.map(async (p) => [p.pairKey, await fetchNavHistory(p.pairKey)] as const));
    setNavByPair(Object.fromEntries(navEntries));
  }

  useEffect(() => {
    reload();
    const interval = setInterval(reload, 30_000);
    return () => clearInterval(interval);
  }, []);

  async function handleModeChange(mode: RunMode) {
    setStatus((prev) => (prev ? { ...prev, runMode: mode } : prev)); // optimistic
    await setRunMode(mode);
    reload();
  }

  async function handleRunNow() {
    setRunningNow(true);
    await runNow();
    setTimeout(() => {
      reload();
      setRunningNow(false);
    }, 3000);
  }

  return (
    <div className="min-h-screen bg-ink-950 text-slate-100">
      <TopNav active={tab} onChange={setTab} unit={unit} onUnitChange={setUnit} />
      {tab === "status" && (
        <StatusTab
          status={status}
          navByPair={navByPair}
          unit={unit}
          runningNow={runningNow}
          onRunNow={handleRunNow}
          onModeChange={handleModeChange}
        />
      )}
      {tab === "timeline" && <TimelineTab status={status} unit={unit} />}
      {tab === "config" && <ConfigTab />}
    </div>
  );
}
