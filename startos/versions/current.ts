import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.5:0',
  releaseNotes: {
    en_US: 'Dashboard: show real live Bitfinex wallet balances (BTC/XAUT/XMR) on the Status tab instead of only derived NAV figures. Timeline: consolidate the trades table into a TradingView-style report (trade #, Return %, and a closed-trades summary of win rate + net PnL). Clean up two stale duplicate DRY_RUN test trade rows left over from an earlier bug.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
