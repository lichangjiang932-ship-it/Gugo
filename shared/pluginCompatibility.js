const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export const PLUGIN_API_VERSION = '1.1.0'
export const PLUGIN_HOST_VERSION = '0.11.49'

function parseSemver(value) {
  if (typeof value !== 'string') return null
  const match = SEMVER_RE.exec(value.trim())
  if (!match) return null
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? Object.freeze(match[4].split('.')) : Object.freeze([]),
  })
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0
    return left.length === 0 ? 1 : -1
  }
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    if (left[index] === right[index]) continue
    const leftNumeric = /^\d+$/.test(left[index])
    const rightNumeric = /^\d+$/.test(right[index])
    if (leftNumeric && rightNumeric) return Number(left[index]) < Number(right[index]) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left[index] < right[index] ? -1 : 1
  }
  return 0
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue)
  const right = parseSemver(rightValue)
  if (!left || !right) return null
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

function upperBoundForCaret(version) {
  if (version.major > 0) return `${version.major + 1}.0.0`
  if (version.minor > 0) return `0.${version.minor + 1}.0`
  return `0.0.${version.patch + 1}`
}

function satisfiesComparator(version, comparator) {
  const match = /^(\^|~|>=|<=|>|<)?(.+)$/.exec(comparator)
  if (!match) return false
  const operator = match[1] || '='
  const target = parseSemver(match[2])
  if (!target) return false
  const comparison = compareSemver(version, match[2])
  if (comparison === null) return false
  if (operator === '=') return comparison === 0
  if (operator === '>') return comparison > 0
  if (operator === '>=') return comparison >= 0
  if (operator === '<') return comparison < 0
  if (operator === '<=') return comparison <= 0
  if (comparison < 0) return false
  const upperBound = operator === '^'
    ? upperBoundForCaret(target)
    : `${target.major}.${target.minor + 1}.0`
  return compareSemver(version, upperBound) < 0
}

export function satisfiesSemverRange(version, range) {
  if (!parseSemver(version) || typeof range !== 'string') return false
  const normalizedRange = range.trim()
  if (normalizedRange === '*') return true
  if (!normalizedRange) return false
  return normalizedRange.split(/\s+/).every((comparator) => (
    satisfiesComparator(version, comparator)
  ))
}

export function isPluginApiVersionCompatible(requested, supported = PLUGIN_API_VERSION) {
  const requestedVersion = parseSemver(requested)
  const supportedVersion = parseSemver(supported)
  if (!requestedVersion || !supportedVersion) return false
  if (requestedVersion.major !== supportedVersion.major) return false
  if (requestedVersion.major === 0
    && requestedVersion.minor !== supportedVersion.minor) return false
  return compareSemver(requested, supported) <= 0
}

function compatibilityError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  Object.assign(error, details)
  return error
}

export function assertPluginCompatibility(manifest, {
  hostVersion,
  apiVersion = PLUGIN_API_VERSION,
  resolveDependencyVersion = () => null,
  checkDependencies = true,
} = {}) {
  if (manifest.apiVersion !== undefined
    && !isPluginApiVersionCompatible(manifest.apiVersion, apiVersion)) {
    throw compatibilityError(
      'PLUGIN_API_VERSION_INCOMPATIBLE',
      `plugin API version is incompatible: ${manifest.id} requires ${manifest.apiVersion}, host provides ${apiVersion}`,
      { pluginId: manifest.id, expectedVersion: manifest.apiVersion, actualVersion: apiVersion },
    )
  }
  if (manifest.hostVersion !== undefined
    && !satisfiesSemverRange(hostVersion, manifest.hostVersion)) {
    throw compatibilityError(
      'PLUGIN_HOST_VERSION_INCOMPATIBLE',
      `plugin host version is incompatible: ${manifest.id} requires ${manifest.hostVersion}, host is ${hostVersion}`,
      { pluginId: manifest.id, expectedVersion: manifest.hostVersion, actualVersion: hostVersion },
    )
  }
  if (!checkDependencies) return true
  for (const dependencyId of manifest.requires) {
    const dependencyVersion = resolveDependencyVersion(dependencyId)
    if (typeof dependencyVersion !== 'string' || !dependencyVersion) {
      throw compatibilityError(
        'PLUGIN_DEPENDENCY_UNAVAILABLE',
        `plugin dependency is unavailable: ${manifest.id} requires ${dependencyId}`,
        { pluginId: manifest.id, dependencyId },
      )
    }
    const range = manifest.dependencyVersions?.[dependencyId]
    if (range !== undefined && !satisfiesSemverRange(dependencyVersion, range)) {
      throw compatibilityError(
        'PLUGIN_DEPENDENCY_VERSION_INCOMPATIBLE',
        `plugin dependency version is incompatible: ${manifest.id} requires ${dependencyId}@${range}, active version is ${dependencyVersion}`,
        {
          pluginId: manifest.id,
          dependencyId,
          expectedVersion: range,
          actualVersion: dependencyVersion,
        },
      )
    }
  }
  return true
}
