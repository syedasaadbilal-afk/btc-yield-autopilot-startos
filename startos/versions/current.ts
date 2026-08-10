import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.1:0',
  releaseNotes: {
    en_US: 'Unified cross-pair portfolio rebalancer replacing independent per-pair execution; redesigned dashboard with Status/Timeline/Config tabs.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
