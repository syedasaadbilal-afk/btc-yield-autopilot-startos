import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.8:0',
  releaseNotes: {
    en_US: 'One-time cleanup and backfill: historical blocked dust top-up rows are removed, and older executions and trades get order summaries and real average fill prices reconstructed from Bitfinex order history (read-only).',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
