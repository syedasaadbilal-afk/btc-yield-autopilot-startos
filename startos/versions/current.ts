import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.9:0',
  releaseNotes: {
    en_US: 'Backfill redone from Bitfinex trade history (long retention, exact fills): every fill is converted to BTC at the BTC/USDT price of its own minute, with a sanity check against the logged amounts. Older executions and trades get order summaries and real average fill prices in USDT and BTC.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
