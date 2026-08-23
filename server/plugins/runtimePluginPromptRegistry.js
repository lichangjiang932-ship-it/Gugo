import { snapshotContributionDefinition } from './pluginContributionDefinition.js'
import {
  createRuntimePluginPromptRenderer,
  snapshotRuntimePluginPromptScope,
} from './pluginPromptInvocation.js'

const PLUGIN_PROMPT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_PLUGIN_PROMPT_BLOCKS = 16
const MAX_PLUGIN_PROMPT_TOTAL_BYTES = 64 * 1024

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function promptRenderError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function assertPromptRegistryDependency(name, value) {
  if (typeof value === 'function') return
  const error = new TypeError(`runtime plugin prompt registry requires ${name}`)
  error.code = 'PLUGIN_PROMPT_REGISTRY_DEPENDENCY_INVALID'
  error.retryable = false
  throw error
}

export function createRuntimePluginPromptRegistry({
  assertPluginWritable,
  assertContributionDeclared,
  createManagedContribution,
  invokePluginCallbackSync,
  emitAudit,
} = {}) {
  for (const [name, dependency] of Object.entries({
    assertPluginWritable,
    assertContributionDeclared,
    createManagedContribution,
    invokePluginCallbackSync,
    emitAudit,
  })) {
    assertPromptRegistryDependency(name, dependency)
  }
  const promptContributions = new Map()
  let promptSequence = 0

  const registerPromptContribution = (record, definition) => {
    assertPluginWritable(record)
    const snapshot = snapshotContributionDefinition(
      definition,
      'plugin prompt definition',
      ['id', 'render'],
    )
    const id = trimmedString(snapshot.id)
    if (!PLUGIN_PROMPT_ID_RE.test(id)) {
      throw new TypeError('plugin prompt id must match [a-z0-9][a-z0-9._-]{0,63}')
    }
    assertContributionDeclared(record, `prompt:${id}`)
    const existing = promptContributions.get(id)
    if (existing && !(record.deferVisibility && existing.pluginId === record.manifest.id)) {
      throw new Error(`plugin prompt already registered: ${id}`)
    }
    const render = snapshot.render
    if (typeof render !== 'function') {
      throw new TypeError('plugin prompt render must be a function')
    }
    const contribution = {
      id,
      pluginId: record.manifest.id,
      record,
      render: createRuntimePluginPromptRenderer({
        record,
        id,
        render,
        invokeSync: invokePluginCallbackSync,
      }),
      sequence: ++promptSequence,
    }
    return createManagedContribution(record, {
      activate() {
        if (promptContributions.has(id)) throw new Error(`plugin prompt already registered: ${id}`)
        promptContributions.set(id, contribution)
        return contribution
      },
      deactivate() {
        if (promptContributions.get(id) !== contribution) return false
        return promptContributions.delete(id)
      },
    })
  }

  const renderPromptBlocks = (input = {}) => {
    const scope = snapshotRuntimePluginPromptScope(input)
    const blocks = []
    const errors = []
    let totalBytes = 0
    const ordered = [...promptContributions.values()].sort((a, b) => a.sequence - b.sequence)
    for (const contribution of ordered) {
      if (contribution.record.state !== 'active') continue
      try {
        if (blocks.length >= MAX_PLUGIN_PROMPT_BLOCKS) {
          throw promptRenderError(
            'PLUGIN_PROMPT_BLOCK_LIMIT',
            `runtime prompt block limit exceeded at ${contribution.id}`,
          )
        }
        const rendered = contribution.render(scope)
        if (rendered == null) continue
        if (totalBytes + rendered.bytes > MAX_PLUGIN_PROMPT_TOTAL_BYTES) {
          throw promptRenderError('PLUGIN_PROMPT_TOTAL_TOO_LARGE', 'runtime prompt blocks exceed 64 KiB')
        }
        totalBytes += rendered.bytes
        blocks.push(Object.freeze({
          id: contribution.id,
          pluginId: contribution.pluginId,
          text: rendered.text,
        }))
      } catch (error) {
        const code = String(error?.code || 'PLUGIN_PROMPT_RENDER_FAILED').slice(0, 80)
        errors.push(Object.freeze({
          id: contribution.id,
          pluginId: contribution.pluginId,
          code,
        }))
        try {
          emitAudit('plugin.prompt_failed', {
            pluginId: contribution.pluginId,
            promptId: contribution.id,
            code,
          })
        } catch { /* audit is best-effort and must preserve prompt fail-open */ }
      }
    }
    return Object.freeze({
      blocks: Object.freeze(blocks),
      errors: Object.freeze(errors),
    })
  }

  return Object.freeze({
    registerPromptContribution,
    renderPromptBlocks,
  })
}
