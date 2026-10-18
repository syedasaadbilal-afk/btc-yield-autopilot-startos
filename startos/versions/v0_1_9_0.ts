import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_9_0 = VersionInfo.of({
  version: '0.1.9:0',
  releaseNotes: {
    en_US: 'Backfill from trade history with per-fill BTC conversion (USDT pairs only).',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
