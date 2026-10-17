import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_8_0 = VersionInfo.of({
  version: '0.1.8:0',
  releaseNotes: {
    en_US: 'Cleanup of blocked dust top-up rows; first backfill attempt from order history.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
