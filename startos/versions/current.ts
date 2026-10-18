import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.10:0',
  releaseNotes: {
    en_US: 'Every filled order is now logged the moment it fills, so a restart mid-run no longer loses the record. The backfill also recovers buys that were never logged (long runs of chunk orders) as labelled recovered rows, and covers executions routed through the direct XMR/BTC (XAUT/BTC) market, not just the USDT pairs. Redone from Bitfinex trade history (long retention, exact fills): every fill is converted to BTC at the BTC/USDT price of its own minute, with a sanity check against the logged amounts. Older executions and trades get order summaries and real average fill prices in USDT and BTC.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
