import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'
export const current = VersionInfo.of({
  version: '0.1.7:0',
  releaseNotes: {
    en_US: 'Timeline now summarises each execution (N orders x ~$X bought/sold Y asset, true average fill price). Extra decision tick at 00:02 UTC (daily-bar close) so TradingView next-bar signals execute within minutes. Trade profit is now computed from real average fill prices (signal prices shown alongside), and the open trade shows an unrealized return. Idle-capital top-ups are now held in BTC when price is more than the max entry distance above the baseline (anti-chase, same rule as fresh entries). Dust idle top-ups that cannot clear the exchange minimum are no longer logged as blocked rows every tick.',
  },
  migrations: { up: async ({ effects }) => {}, down: IMPOSSIBLE },
})
