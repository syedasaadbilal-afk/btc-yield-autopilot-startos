import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_10_0 = VersionInfo.of({
  version: '0.1.10:0',
  releaseNotes: {
    en_US: 'Crash-safe fill logging, recovery of unlogged buys, direct-market backfill, position average cost.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
