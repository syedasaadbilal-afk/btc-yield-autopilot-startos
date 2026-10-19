import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_13_0 = VersionInfo.of({
  version: '0.1.13:0',
  releaseNotes: {
    en_US: 'NAV fix, leftover sweep, optional XAUT entry block by BTC 4-year SMA.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
