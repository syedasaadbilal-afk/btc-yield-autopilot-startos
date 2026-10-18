import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.11:0',
  releaseNotes: {
    en_US: 'Signal prices follow the TradingView convention (open of the bar a signal executes in), with a restatement of past trades. The funded baseline and percentage of a pair holding its asset now use the real cost of the units held (average buy price from real fills), so later deposits and top-ups no longer show as profit. The backfill logs an exchange-history reconciliation (bought, sold, fees versus wallet), and the average-cost line shows how much of the held balance it covers. Every filled order is logged the moment it fills, unlogged buys are recovered as labelled rows, and the direct XMR/BTC market is covered.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
