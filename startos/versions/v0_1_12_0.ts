import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const v_0_1_12_0 = VersionInfo.of({
  version: '0.1.12:0',
  releaseNotes: {
    en_US: 'Closed trades valued on real fills; BTC leg shown on the Timeline.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
