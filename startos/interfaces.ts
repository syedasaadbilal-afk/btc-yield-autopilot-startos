import { i18n } from './i18n'
import { sdk } from './sdk'
import { uiPort } from './utils'

// The Starttunnel-relevant part: MultiHost + bindPort(..., { protocol:
// 'http' }) with type: 'ui', masked: false is the shape StartOS's remote
// tunnel hooks into (same pattern Hashrate Autopilot uses).
export const setInterfaces = sdk.setupInterfaces(async ({ effects }) => {
  const uiMulti = sdk.MultiHost.of(effects, 'ui-multi')
  const uiMultiOrigin = await uiMulti.bindPort(uiPort, { protocol: 'http' })
  const ui = sdk.createInterface(effects, {
    name: i18n('Dashboard'),
    id: 'ui',
    description: i18n('The BTC Yield Autopilot web dashboard'),
    type: 'ui',
    masked: false,
    schemeOverride: null,
    username: null,
    path: '',
    query: {},
  })
  const uiReceipt = await uiMultiOrigin.export([ui])
  return [uiReceipt]
})
