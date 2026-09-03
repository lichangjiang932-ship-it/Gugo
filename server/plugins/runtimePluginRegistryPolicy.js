import { assertPluginCompatibility } from '../../shared/pluginCompatibility.js'
import {
  PLUGIN_API_VERSION,
  PLUGIN_HOST_VERSION,
} from './pluginHostContract.js'

export function createRuntimePluginRegistryPolicy({ plugins, stagingRecords } = {}) {
  if (!(plugins instanceof Map) || !(stagingRecords instanceof Set)) {
    throw new TypeError('runtime plugin registry policy requires host-owned collections')
  }

  const assertRecordCanDeactivate = (record) => {
    for (const check of record.deactivationChecks) check()
  }

  const assertPluginWritable = (record) => {
    if (!['installing', 'staging', 'active'].includes(record.state)) {
      throw new Error(`plugin lifecycle is closed: ${record.manifest.id}`)
    }
  }

  const registerConfigHealthCheck = (record, check) => {
    assertPluginWritable(record)
    if (typeof check !== 'function') {
      const error = new TypeError('plugin config health check must be a function')
      error.code = 'PLUGIN_CONFIG_HEALTH_CHECK_INVALID'
      error.retryable = false
      throw error
    }
    record.configHealthChecks.add(check)
    return record.effects.track(() => record.configHealthChecks.delete(check))
  }

  const assertContributionDeclared = (record, declaration) => {
    if (record.manifest.contributes.includes(declaration)) return
    const error = new Error(`plugin contribution is not declared: ${record.manifest.id}/${declaration}`)
    error.code = 'PLUGIN_CONTRIBUTION_UNDECLARED'
    error.retryable = false
    throw error
  }

  const assertManifestCompatible = (manifest) => assertPluginCompatibility(manifest, {
    hostVersion: PLUGIN_HOST_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    resolveDependencyVersion: (id) => {
      const dependency = plugins.get(id)
      return dependency?.state === 'active' ? dependency.manifest.version : null
    },
  })

  const isConsumerRecordCurrent = (record) => (
    plugins.get(record.manifest.id) === record || stagingRecords.has(record)
  )

  return Object.freeze({
    assertRecordCanDeactivate,
    assertPluginWritable,
    registerConfigHealthCheck,
    assertContributionDeclared,
    assertManifestCompatible,
    isConsumerRecordCurrent,
  })
}
