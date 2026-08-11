import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.4:0',
  releaseNotes: {
    en_US: 'Fix allocation-transition gating bug: real reallocation trades now fire on every regime-driven transition (100% splitting into 50/50 dual-gold, 50/50 collapsing back to 100%, or moving between the two single-gold 100/0 states), not just once already at a stable split; steady state only accepts idle/new-money top-ups. Generalize idle-capital top-up routing to single-gold (100/0) states in addition to dual-gold.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
