import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_6_0 = VersionInfo.of({
  version: '0.1.6:0',
  releaseNotes: {
    en_US: 'Fix bootstrap wallet-position check that blocked every LIVE tick at a 50/50 split.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
