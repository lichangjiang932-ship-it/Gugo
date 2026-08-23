import fs from 'node:fs'

import {
  PLUGIN_API_VERSION,
  PLUGIN_HOST_VERSION,
} from '../../shared/pluginCompatibility.js'
import { POLICY_ADAPTER_CONTRACT_VERSION } from '../core/policyAdapter.js'

const packageMetadata = JSON.parse(fs.readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
))

if (packageMetadata.version !== PLUGIN_HOST_VERSION) {
  throw new Error(
    `plugin host version ${PLUGIN_HOST_VERSION} does not match package version ${packageMetadata.version}`,
  )
}

export { PLUGIN_API_VERSION, PLUGIN_HOST_VERSION, POLICY_ADAPTER_CONTRACT_VERSION }
