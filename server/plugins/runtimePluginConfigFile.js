import { createHash, timingSafeEqual } from 'node:crypto'

import {
  readRuntimeConfigFileSnapshot,
  resolveRuntimeConfigPaths,
} from '../utils/runtimeEnv.js'
import { normalizePluginConfigLayers } from './pluginConfig.js'

function configFileError(message, sourcePath = null) {
  const error = new TypeError(message)
  error.code = 'PLUGIN_CONFIG_FILE_INVALID'
  error.statusCode = 422
  error.retryable = false
  if (sourcePath) error.sourcePath = sourcePath
  return error
}

function readLayers(filePath, document, source = 'runtime_config') {
  if (!filePath || document === null) return []
  if (!document?.env || typeof document.env !== 'object' || Array.isArray(document.env)) return []
  if (document.pluginConfig === undefined) return []
  if (!document.pluginConfig
    || typeof document.pluginConfig !== 'object'
    || Array.isArray(document.pluginConfig)) {
    throw configFileError('runtime pluginConfig must be an object', filePath)
  }
  const unknown = Object.keys(document.pluginConfig).filter((key) => key !== 'layers')
  if (unknown.length > 0) {
    throw configFileError('runtime pluginConfig contains unsupported fields', filePath)
  }
  if (document.pluginConfig.layers === undefined) return []
  if (!Array.isArray(document.pluginConfig.layers)) {
    throw configFileError('runtime pluginConfig.layers must be an array', filePath)
  }
  const layers = document.pluginConfig.layers
  try {
    normalizePluginConfigLayers(layers, { source })
  } catch (error) {
    if (error?.code !== 'PLUGIN_CONFIG_LAYERS_INVALID') throw error
    const wrapped = configFileError(error.message, filePath)
    wrapped.cause = error
    throw wrapped
  }
  return layers
}

/** Validate pluginConfig metadata without reading or installing any plugin. */
export function validateRuntimePluginConfigDocument(document, {
  sourcePath = null,
} = {}) {
  readLayers(sourcePath, document, 'recovery')
  return true
}

function sourceFingerprint(sources) {
  const hash = createHash('sha256')
  hash.update('gugo-runtime-plugin-config-v1\0')
  for (const source of sources) {
    const pathBytes = Buffer.from(source.path, 'utf8')
    const sourceBytes = Buffer.from(source.source, 'utf8')
    hash.update(String(sourceBytes.length))
    hash.update('\0')
    hash.update(sourceBytes)
    hash.update(String(pathBytes.length))
    hash.update('\0')
    hash.update(pathBytes)
    hash.update(source.content === null ? '\0missing\0' : '\0present\0')
    if (source.content !== null) {
      hash.update(String(source.content.length))
      hash.update('\0')
      hash.update(source.content)
    }
  }
  return hash.digest()
}

function readSource(source, filePath) {
  const snapshot = readRuntimeConfigFileSnapshot(filePath)
  return Object.freeze({
    source,
    path: filePath,
    content: snapshot.content,
    layers: readLayers(filePath, snapshot.document, source),
  })
}

export function readRuntimePluginConfigSourceSnapshot({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const paths = resolveRuntimeConfigPaths({ cwd, env })
  const descriptors = [
    readSource('user_config', paths.user),
    readSource('project_config', paths.project),
  ]
  if (paths.explicit && ![paths.user, paths.project].includes(paths.explicit)) {
    descriptors.push(readSource('explicit_config', paths.explicit))
  }
  const layerSources = descriptors
    .filter((entry) => entry.layers.length > 0)
    .map((entry) => Object.freeze({ source: entry.source, layers: entry.layers }))
  return Object.freeze({
    fingerprint: sourceFingerprint(descriptors),
    layerSources: Object.freeze(layerSources),
  })
}

export function assertRuntimePluginConfigSourceSnapshot(snapshot, options = {}) {
  const expected = snapshot?.fingerprint
  if (!Buffer.isBuffer(expected) || expected.length !== 32) {
    throw configFileError('runtime plugin config source snapshot is invalid')
  }
  let current
  try {
    current = readRuntimePluginConfigSourceSnapshot(options).fingerprint
  } catch {
    current = null
  }
  if (current && timingSafeEqual(expected, current)) return true
  const error = new Error('runtime plugin configuration changed during reload')
  error.code = 'PLUGIN_CONFIG_SOURCE_CHANGED'
  error.statusCode = 409
  error.retryable = true
  throw error
}

export function readRuntimePluginConfigLayerSources({
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  return readRuntimePluginConfigSourceSnapshot({ cwd, env }).layerSources
}
