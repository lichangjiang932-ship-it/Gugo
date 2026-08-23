import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { prepareTurnPersistenceAdapter } from './turnPersistenceAdapter.js'

export const TURN_PERSISTENCE_MODULE_ENV = 'GUGO_TURN_PERSISTENCE_MODULE'
export const TURN_PERSISTENCE_TRUST_ROOT_ENV = 'GUGO_TURN_PERSISTENCE_TRUST_ROOT'

function bootstrapResult(adapter, provenance) {
  const frozenProvenance = Object.freeze(provenance)
  return Object.freeze({ adapter, provenance: frozenProvenance })
}

function bootstrapError(code, message, cause = null) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  if (cause) error.cause = cause
  return error
}

function configuredString(env, key) {
  let value
  try {
    const descriptor = Object.getOwnPropertyDescriptor(env || {}, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
    value = descriptor.value
  } catch (cause) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_CONFIG_INVALID',
      `trusted persistence bootstrap could not read ${key}`,
      cause,
    )
  }
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.trim() !== value || value.includes('\0')) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_CONFIG_INVALID',
      `${key} must be a normalized local filesystem path`,
    )
  }
  return value
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  )
}

async function canonicalDirectory(input, realpath, stat) {
  let canonical
  try {
    canonical = await realpath(input)
    const info = await stat(canonical)
    if (!info?.isDirectory?.()) throw new Error('not a directory')
  } catch (cause) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_TRUST_ROOT_INVALID',
      'trusted persistence root must be an existing local directory',
      cause,
    )
  }
  return canonical
}

async function canonicalModule(input, cwd, root, realpath, stat) {
  if (/^file:/iu.test(input) || (!path.isAbsolute(input) && /^[a-z][a-z0-9+.-]*:/iu.test(input))) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_MODULE_INVALID',
      'trusted persistence module must use a local filesystem path, not a URL',
    )
  }
  const requested = path.resolve(cwd, input)
  let canonical
  try {
    canonical = await realpath(requested)
    const info = await stat(canonical)
    if (!info?.isFile?.()) throw new Error('not a regular file')
  } catch (cause) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_MODULE_INVALID',
      'trusted persistence module must be an existing regular file',
      cause,
    )
  }
  if (!isInside(root, canonical)) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_MODULE_OUTSIDE_TRUST_ROOT',
      'trusted persistence module resolves outside the configured trust root',
    )
  }
  return canonical
}

function ownDataExport(namespace, key) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(namespace, key)
  } catch (cause) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_EXPORT_INVALID',
      `trusted persistence module export ${key} could not be inspected`,
      cause,
    )
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { found: false, value: null }
  return { found: true, value: descriptor.value }
}

function prepareSelectedAdapter(input, source) {
  try {
    return prepareTurnPersistenceAdapter(input)
  } catch (cause) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_ADAPTER_INVALID',
      `${source} does not export a complete Turn persistence adapter`,
      cause,
    )
  }
}

/**
 * Resolve one process-owned Turn persistence adapter before ordinary runtime
 * plugins, migrations, or lifecycle consumers start. The module path is a
 * deployment/bootstrap setting; it is deliberately not read from plugin
 * inventory or runtime_plugin_states.
 */
export async function resolveTurnPersistenceBootstrap({
  cwd = process.cwd(),
  env = process.env,
  trustedRoot = null,
  builtinAdapter = null,
  builtinAdapterFactory = null,
  importModule = (specifier) => import(specifier),
  realpath = (target) => fs.promises.realpath(target),
  stat = (target) => fs.promises.stat(target),
} = {}) {
  const configuredModule = configuredString(env, TURN_PERSISTENCE_MODULE_ENV)
  if (!configuredModule) {
    let selectedBuiltinAdapter = builtinAdapter
    if (!selectedBuiltinAdapter && builtinAdapterFactory !== null) {
      if (typeof builtinAdapterFactory !== 'function') {
        throw bootstrapError(
          'TURN_PERSISTENCE_BOOTSTRAP_HOST_INVALID',
          'the built-in persistence adapter factory must be a function',
        )
      }
      try {
        selectedBuiltinAdapter = await builtinAdapterFactory()
      } catch (cause) {
        throw bootstrapError(
          'TURN_PERSISTENCE_BOOTSTRAP_BUILTIN_LOAD_FAILED',
          'the distribution default Turn persistence adapter could not be loaded',
          cause,
        )
      }
    }
    if (!selectedBuiltinAdapter) {
      throw bootstrapError(
        'TURN_PERSISTENCE_BOOTSTRAP_BUILTIN_REQUIRED',
        'the distribution must provide its default Turn persistence adapter',
      )
    }
    const adapter = prepareSelectedAdapter(
      selectedBuiltinAdapter,
      'the built-in persistence backend',
    )
    return bootstrapResult(adapter, {
        source: 'builtin',
        configured: false,
        modulePath: null,
        adapterId: adapter.id,
        contractVersion: adapter.contractVersion,
    })
  }

  if (typeof importModule !== 'function'
    || typeof realpath !== 'function'
    || typeof stat !== 'function') {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_HOST_INVALID',
      'trusted persistence bootstrap host adapters must be functions',
    )
  }

  const configuredRoot = trustedRoot
    ?? configuredString(env, TURN_PERSISTENCE_TRUST_ROOT_ENV)
    ?? cwd
  if (typeof configuredRoot !== 'string'
    || !configuredRoot
    || configuredRoot.trim() !== configuredRoot
    || configuredRoot.includes('\0')) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_TRUST_ROOT_INVALID',
      'trusted persistence root must be a normalized local filesystem path',
    )
  }
  const canonicalRoot = await canonicalDirectory(path.resolve(cwd, configuredRoot), realpath, stat)
  const modulePath = await canonicalModule(
    configuredModule,
    cwd,
    canonicalRoot,
    realpath,
    stat,
  )

  let namespace
  try {
    namespace = await importModule(pathToFileURL(modulePath).href)
  } catch (cause) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_IMPORT_FAILED',
      'trusted persistence module could not be imported',
      cause,
    )
  }
  if (!namespace || (typeof namespace !== 'object' && typeof namespace !== 'function')) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_EXPORT_INVALID',
      'trusted persistence module must expose an ESM namespace',
    )
  }
  const named = ownDataExport(namespace, 'turnPersistenceAdapter')
  const fallback = named.found ? named : ownDataExport(namespace, 'default')
  if (!fallback.found) {
    throw bootstrapError(
      'TURN_PERSISTENCE_BOOTSTRAP_EXPORT_INVALID',
      'trusted persistence module must export turnPersistenceAdapter or default',
    )
  }
  const adapter = prepareSelectedAdapter(fallback.value, 'the trusted persistence module')
  return bootstrapResult(adapter, {
      source: 'module',
      configured: true,
      modulePath,
      trustedRoot: canonicalRoot,
      adapterId: adapter.id,
      contractVersion: adapter.contractVersion,
  })
}
