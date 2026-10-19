import { VersionGraph } from '@start9labs/start-sdk'
import { current } from './current'
import { v_0_1_6_0 } from './v0_1_6_0'
import { v_0_1_7_0 } from './v0_1_7_0'
import { v_0_1_8_0 } from './v0_1_8_0'
import { v_0_1_9_0 } from './v0_1_9_0'
import { v_0_1_10_0 } from './v0_1_10_0'
import { v_0_1_11_0 } from './v0_1_11_0'
import { v_0_1_12_0 } from './v0_1_12_0'

export const versionGraph = VersionGraph.of({
  current,
  other: [v_0_1_6_0, v_0_1_7_0, v_0_1_8_0, v_0_1_9_0, v_0_1_10_0, v_0_1_11_0, v_0_1_12_0],
})
