import { createRuntimePluginService } from './pluginServiceInvocation.js'

const PLUGIN_SERVICE_CONSUMER_STATES = new Set([
  'installing',
  'staging',
  'active',
  'draining',
  'cancelling',
  'failed',
  'uninstalling',
])

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function serviceConsumerError(record, code, message) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  error.pluginId = record.manifest.id
  return error
}

export function createRuntimePluginServiceRegistry({
  assertContributionDeclared,
  assertPluginWritable,
  createManagedContribution,
  invokePluginCallback,
  isConsumerRecordCurrent,
}) {
  const services = new Map()

  const provideService = (record, name, value) => {
    assertPluginWritable(record)
    const normalizedName = trimmedString(name)
    if (!normalizedName) throw new TypeError('plugin service name is required')
    assertContributionDeclared(record, `service:${normalizedName}`)
    const existing = services.get(normalizedName)
    if (existing && !(record.deferVisibility && existing.pluginId === record.manifest.id)) {
      throw new Error(`plugin service already provided: ${normalizedName}`)
    }
    const contribution = {
      pluginId: record.manifest.id,
      record,
      service: createRuntimePluginService({
        record,
        name: normalizedName,
        value,
        invoke: invokePluginCallback,
      }),
    }
    return createManagedContribution(record, {
      activate() {
        if (services.has(normalizedName)) {
          throw new Error(`plugin service already provided: ${normalizedName}`)
        }
        services.set(normalizedName, contribution)
        return contribution
      },
      deactivate() {
        if (services.get(normalizedName) !== contribution) return false
        contribution.service.revoke()
        return services.delete(normalizedName)
      },
    })
  }

  const invokeService = async (name, method, args = [], executionContext = null) => {
    const normalizedName = trimmedString(name)
    const normalizedMethod = trimmedString(method)
    const contribution = services.get(normalizedName)
    if (!contribution || contribution.record.state !== 'active') {
      return Object.freeze({ found: false, pluginId: null, value: undefined })
    }
    const value = await contribution.service.invoke(normalizedMethod, args, executionContext)
    return Object.freeze({
      found: true,
      pluginId: contribution.pluginId,
      value,
    })
  }

  const assertServiceConsumerAvailable = (record) => {
    if (isConsumerRecordCurrent(record) && PLUGIN_SERVICE_CONSUMER_STATES.has(record.state)) return
    throw serviceConsumerError(
      record,
      'PLUGIN_SERVICE_CONSUMER_INACTIVE',
      `plugin service consumer is no longer active: ${record.manifest.id}`,
    )
  }

  const serviceForConsumer = (record, name) => {
    assertServiceConsumerAvailable(record)
    const normalizedName = trimmedString(name)
    const contribution = services.get(normalizedName)
    if (!contribution || contribution.record.state !== 'active') {
      return { normalizedName, contribution: null }
    }
    if (contribution.record !== record
      && !record.manifest.requires.includes(contribution.pluginId)) {
      const error = serviceConsumerError(
        record,
        'PLUGIN_SERVICE_DEPENDENCY_UNDECLARED',
        `plugin service provider is not declared as a dependency: ${record.manifest.id}/${contribution.pluginId}`,
      )
      error.serviceName = normalizedName
      error.providerPluginId = contribution.pluginId
      throw error
    }
    return { normalizedName, contribution }
  }

  const invokeServiceForConsumer = async (record, name, method, args = []) => {
    const { normalizedName, contribution } = serviceForConsumer(record, name)
    if (!contribution) {
      return Object.freeze({ found: false, pluginId: null, value: undefined })
    }
    return invokeService(normalizedName, method, args)
  }

  const hasServiceForConsumer = (record, name) => {
    try {
      return serviceForConsumer(record, name).contribution !== null
    } catch (error) {
      if (error?.code === 'PLUGIN_SERVICE_DEPENDENCY_UNDECLARED') return false
      throw error
    }
  }

  const hasService = (name) => {
    const contribution = services.get(trimmedString(name))
    return contribution?.record?.state === 'active'
  }

  return Object.freeze({
    hasService,
    hasServiceForConsumer,
    invokeService,
    invokeServiceForConsumer,
    provideService,
  })
}
