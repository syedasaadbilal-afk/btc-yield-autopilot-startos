import { i18n } from './i18n'
import { sdk } from './sdk'
import { uiPort } from './utils'

export const main = sdk.setupMain(async ({ effects }) => {
  console.info(i18n('Starting BTC Yield Autopilot'))

  return sdk.Daemons.of(effects).addDaemon('primary', {
    subcontainer: await sdk.SubContainer.of(
      effects,
      { imageId: 'autopilot' },
      sdk.Mounts.of().mountVolume({
        volumeId: 'main',
        subpath: null,
        // Matches the existing Dockerfile's VOLUME ["/data"] declaration
        // (see packages/../Dockerfile) - keep these in sync.
        mountpoint: '/data',
        readonly: false,
      }),
      'autopilot-sub',
    ),
    exec: {
      // Matches the Dockerfile's CMD exactly - the daemon runs via
      // ts-node/esm directly (no separate compile step) from
      // packages/daemon. Bitfinex API credentials are NOT set here - see
      // packages/daemon/src/secrets.ts; they're entered through the
      // dashboard's Config tab and persisted into the mounted volume,
      // never baked into this static env block.
      command: ['node', '--experimental-sqlite', '--loader', 'ts-node/esm', 'src/index.ts'],
      cwd: '/app/packages/daemon',
      env: {
        NODE_ENV: 'production',
        DASHBOARD_PORT: String(uiPort),
        AUTOPILOT_DB_PATH: '/data/autopilot.sqlite',
        AUTOPILOT_RUN_MODE: 'DRY_RUN',
      },
    },
    ready: {
      display: i18n('Dashboard'),
      fn: () =>
        sdk.healthCheck.checkPortListening(effects, uiPort, {
          successMessage: i18n('The dashboard is ready'),
          errorMessage: i18n('The dashboard is not ready'),
        }),
    },
    requires: [],
  })
})
