import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '0.1.0:0',
  releaseNotes: {
    en_US: 'Initial StartOS package: Larsson rotation autopilot, cross-pair allocation, Starttunnel-ready dashboard.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
