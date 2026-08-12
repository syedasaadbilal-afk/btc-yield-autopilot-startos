import { useEffect, useState, type ReactNode } from "react";
import {
  fetchAllocationOverride,
  fetchBitfinexSecretsStatus,
  fetchConfig,
  saveAllocationOverride,
  saveBitfinexSecrets,
  type ActiveStrategyConfig,
} from "../api.js";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-sm py-1 border-b border-slate-800/60 last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200">{value}</span>
    </div>
  );
}

function ConfigSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-ink-900 border border-slate-800 rounded-lg p-4">
      <h3 className="text-xs font-semibold tracking-wider text-slate-300 uppercase mb-2">{title}</h3>
      {children}
    </div>
  );
}

function BitfinexCredentials() {
  const [configured, setConfigured] = useState<boolean | undefined>(undefined);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);

  useEffect(() => {
    fetchBitfinexSecretsStatus().then((s) => setConfigured(s.configured));
  }, []);

  async function handleSave() {
    if (!apiKey || !apiSecret) return;
    setSaving(true);
    const result = await saveBitfinexSecrets(apiKey, apiSecret);
    setSaving(false);
    if (result) {
      setConfigured(result.configured);
      setNote(result.note ?? "Saved.");
      setApiKey("");
      setApiSecret("");
    } else {
      setNote("Failed to save - check the daemon is reachable.");
    }
  }

  return (
    <ConfigSection title="Bitfinex API credentials">
      <div className="flex items-center gap-2 pb-2">
        <span className={`inline-block w-2 h-2 rounded-full ${configured ? "bg-emerald-400" : "bg-slate-600"}`} />
        <span className="text-xs text-slate-400">{configured ? "credentials configured" : "not configured"}</span>
      </div>
      <div className="space-y-2">
        <input
          type="text"
          placeholder="API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="w-full bg-ink-950 border border-slate-800 rounded px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-600"
        />
        <input
          type="password"
          placeholder="API secret"
          value={apiSecret}
          onChange={(e) => setApiSecret(e.target.value)}
          className="w-full bg-ink-950 border border-slate-800 rounded px-2 py-1.5 text-sm text-slate-200 placeholder:text-slate-600"
        />
        <button
          onClick={handleSave}
          disabled={saving || !apiKey || !apiSecret}
          className="px-3 py-1.5 rounded text-sm font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50 border border-slate-700"
        >
          {saving ? "Saving..." : "Save credentials"}
        </button>
        {note && <p className="text-xs text-amber-400">{note}</p>}
        <p className="text-xs text-slate-600">
          Stored in a file inside the daemon's data volume, never in the image or the running config. The daemon needs a
          restart to pick up new credentials.
        </p>
      </div>
    </ConfigSection>
  );
}

function AllocationOverride() {
  const [enabled, setEnabled] = useState(false);
  const [xautPct, setXautPct] = useState(50);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchAllocationOverride().then((o) => {
      setEnabled(o.enabled);
      setXautPct(Math.round(o.xautFraction * 100));
      setLoaded(true);
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    const result = await saveAllocationOverride(enabled, xautPct / 100);
    setSaving(false);
    setNote(result ? "Saved. Takes effect on the next tick." : "Failed to save - check the daemon is reachable.");
  }

  return (
    <ConfigSection title="XAUT/XMR allocation override">
      <label className="flex items-center gap-2 pb-2 text-xs text-slate-400">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Manually pin the split (overrides the regime-driven default)
      </label>
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            value={xautPct}
            disabled={!enabled || !loaded}
            onChange={(e) => setXautPct(Number(e.target.value))}
            className="flex-1 disabled:opacity-40"
          />
          <span className="text-sm text-slate-200 w-32 text-right shrink-0">
            XAUT {xautPct}% / XMR {100 - xautPct}%
          </span>
        </div>
        <button
          onClick={handleSave}
          disabled={saving || !loaded}
          className="px-3 py-1.5 rounded text-sm font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50 border border-slate-700"
        >
          {saving ? "Saving..." : "Save allocation"}
        </button>
        {note && <p className="text-xs text-amber-400">{note}</p>}
        <p className="text-xs text-slate-600">
          Each pair's own entry/exit still runs independently off its Larsson regime - this only changes the split
          used while both pairs are eligible to hold their asset. No change here means no trade; changing it triggers
          exactly one resize toward the new split.
        </p>
      </div>
    </ConfigSection>
  );
}

/** Read-only strategy config snapshot - matches Hashrate Autopilot's BRAIINS/DATUM/OCEAN detail-panel style. */
export function ConfigTab() {
  const [config, setConfig] = useState<ActiveStrategyConfig | undefined>(undefined);

  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);

  if (!config) {
    return <div className="text-slate-500 p-6">Loading config...</div>;
  }

  return (
    <div className="space-y-4 p-6">
      <p className="text-xs text-slate-500">
        Live, running config for this daemon - not the dashboard bundle's build-time defaults. Only the Bitfinex
        credentials and the XAUT/XMR allocation override below are editable from here; everything else requires
        changing PairConfig/StrategyConfig and redeploying.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BitfinexCredentials />
        <AllocationOverride />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ConfigSection title="Larsson Baseline + Overextension Rotation">
          <Row label="fast period (v1)" value={String(config.larsson.fastPeriod)} />
          <Row label="mid period 1" value={String(config.larsson.midPeriod1)} />
          <Row label="mid period 2" value={String(config.larsson.midPeriod2)} />
          <Row label="baseline period (v2)" value={String(config.larsson.baselinePeriod)} />
          <Row label="overextension fraction" value={`${(config.larsson.overextensionFraction * 100).toFixed(1)}%`} />
          <Row label="entry max dist fraction" value={`${(config.larsson.entryMaxDistFraction * 100).toFixed(1)}%`} />
        </ConfigSection>

        <ConfigSection title="Capital">
          <Row label="starting BTC" value={config.capital.startingBtc.toFixed(8)} />
          <Row label="wallet" value={config.capital.wallet} />
        </ConfigSection>

        <ConfigSection title="Risk">
          <Row label="risk fraction per trade" value={`${(config.risk.riskFractionPerTrade * 100).toFixed(2)}%`} />
          <Row label="ATR period" value={String(config.risk.atrPeriod)} />
          <Row label="ATR stop multiplier" value={String(config.risk.atrStopMultiplier)} />
          <Row label="min reward:risk" value={String(config.risk.minRewardRiskRatio)} />
          <Row label="tranche weights" value={config.risk.trancheWeights.map((w) => `${(w * 100).toFixed(0)}%`).join(" / ")} />
          <Row label="cooldown after stop" value={`${config.risk.cooldownDaysAfterStop} days`} />
          <Row label="drawdown circuit breaker" value={`${(config.risk.drawdownCircuitBreakerFraction * 100).toFixed(0)}%`} />
        </ConfigSection>

        <ConfigSection title="Execution">
          <Row label="clips per tranche" value={String(config.execution.numClipsPerTranche)} />
          <Row label="layering window" value={`${Math.round(config.execution.layeringWindowMs / 60000)} min`} />
          <Row label="max book depth per clip" value={`${(config.execution.maxFractionOfBookDepthPerClip * 100).toFixed(0)}%`} />
          <Row label="max slippage" value={`${(config.execution.maxSlippageBtcFractionOfTrade * 100).toFixed(2)}%`} />
          <Row label="leg fallback enabled" value={config.execution.legFallback.enabled ? "yes" : "no"} />
          <Row label="min ratio depth (fallback)" value={`$${config.execution.legFallback.minRatioDepthUsd.toLocaleString()}`} />
        </ConfigSection>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {config.pairs.map((pair) => (
          <ConfigSection key={pair.key} title={pair.displayName}>
            <Row label="asset currency" value={pair.assetCurrency} />
            <Row label="ratio symbol" value={pair.ratioSymbol} />
            <Row label="ratio convention" value={pair.ratioConvention} />
            <Row label="static capital fraction (fallback)" value={`${(pair.capitalFractionBtc * 100).toFixed(0)}%`} />
            <Row label="BTC/USDT symbol" value={pair.btcUsdtSymbol} />
            <Row label="asset/USDT symbol" value={pair.assetUsdtSymbol} />
            <Row label="min ratio depth" value={`$${pair.minRatioDepthUsd.toLocaleString()}`} />
          </ConfigSection>
        ))}
      </div>
    </div>
  );
}
