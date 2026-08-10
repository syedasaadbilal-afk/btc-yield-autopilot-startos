export const short = {
  en_US: "Larsson Baseline + Overextension rotation autopilot for BTC/XAUT/XMR on Bitfinex",
}

export const long = {
  en_US:
    "Spot-only BTC yield autopilot. Rotates between BTC and gold (XAUT)/Monero (XMR) using a Larsson " +
    "Baseline + Overextension regime model, ported directly from a TradingView-backtested Pine Script. " +
    "Cross-pair capital allocation follows regime strength (100% to a single gold pair, 50/50 if both are " +
    "gold, 100% BTC if both are blue) while entry/exit timing for each pair stays fully independent. " +
    "Tracks BTC-denominated NAV and PnL (not USD) per the objective: more BTC, not more dollars. " +
    "Boots in DRY_RUN mode: it will not place real orders until you explicitly switch to LIVE on the dashboard.",
}
