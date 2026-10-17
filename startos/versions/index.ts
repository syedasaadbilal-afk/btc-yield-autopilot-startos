import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'
import { v_0_1_6_0 } from './v0_1_6_0'

export const versionGraph = VersionGraph.of({
  current,
  other: [v_0_1_6_0],
})
