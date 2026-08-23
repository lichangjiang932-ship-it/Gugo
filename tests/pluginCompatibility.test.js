import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertPluginCompatibility,
  compareSemver,
  isPluginApiVersionCompatible,
  PLUGIN_HOST_VERSION,
  satisfiesSemverRange,
} from '../shared/pluginCompatibility.js'
import { PLUGIN_HOST_VERSION as SERVER_PLUGIN_HOST_VERSION } from '../server/plugins/pluginHostContract.js'

test('plugin semver compatibility supports the declared range grammar', () => {
  assert.equal(compareSemver('1.2.3', '1.2.3+build.7'), 0)
  assert.equal(compareSemver('1.2.3-rc.1', '1.2.3'), -1)
  assert.equal(satisfiesSemverRange('2.4.1', '^2.3.0'), true)
  assert.equal(satisfiesSemverRange('3.0.0', '^2.3.0'), false)
  assert.equal(satisfiesSemverRange('0.2.9', '^0.2.3'), true)
  assert.equal(satisfiesSemverRange('0.3.0', '^0.2.3'), false)
  assert.equal(satisfiesSemverRange('1.4.9', '~1.4.2'), true)
  assert.equal(satisfiesSemverRange('1.5.0', '~1.4.2'), false)
  assert.equal(satisfiesSemverRange('0.11.31', '>=0.11.0 <1.0.0'), true)
  assert.equal(satisfiesSemverRange('0.11.31', '*'), true)
  assert.equal(satisfiesSemverRange('invalid', '*'), false)
})

test('plugin API compatibility preserves one stable API line', () => {
  assert.equal(isPluginApiVersionCompatible('1.0.0', '1.2.0'), true)
  assert.equal(isPluginApiVersionCompatible('1.3.0', '1.2.0'), false)
  assert.equal(isPluginApiVersionCompatible('2.0.0', '1.9.9'), false)
  assert.equal(isPluginApiVersionCompatible('0.3.0', '0.3.2'), true)
  assert.equal(isPluginApiVersionCompatible('0.2.9', '0.3.2'), false)
})

test('browser and server plugin registries share the package host version', async () => {
  const packageMetadata = (await import('../package.json', { with: { type: 'json' } })).default
  assert.equal(PLUGIN_HOST_VERSION, packageMetadata.version)
  assert.equal(SERVER_PLUGIN_HOST_VERSION, packageMetadata.version)
})

test('plugin compatibility rejects host, API, missing dependency, and dependency version mismatches', () => {
  const base = {
    id: 'contract-consumer',
    version: '1.0.0',
    requires: [],
    dependencyVersions: {},
  }
  assert.throws(
    () => assertPluginCompatibility({ ...base, apiVersion: '2.0.0' }, {
      hostVersion: '0.11.31',
      apiVersion: '1.0.0',
    }),
    (error) => error?.code === 'PLUGIN_API_VERSION_INCOMPATIBLE'
      && error?.retryable === false,
  )
  assert.throws(
    () => assertPluginCompatibility({ ...base, hostVersion: '>=1.0.0' }, {
      hostVersion: '0.11.31',
      apiVersion: '1.0.0',
    }),
    (error) => error?.code === 'PLUGIN_HOST_VERSION_INCOMPATIBLE',
  )
  const dependent = {
    ...base,
    requires: ['base-plugin'],
    dependencyVersions: { 'base-plugin': '^2.0.0' },
  }
  assert.throws(
    () => assertPluginCompatibility(dependent, {
      hostVersion: '0.11.31',
      resolveDependencyVersion: () => null,
    }),
    (error) => error?.code === 'PLUGIN_DEPENDENCY_UNAVAILABLE'
      && error?.dependencyId === 'base-plugin',
  )
  assert.throws(
    () => assertPluginCompatibility(dependent, {
      hostVersion: '0.11.31',
      resolveDependencyVersion: () => '1.9.9',
    }),
    (error) => error?.code === 'PLUGIN_DEPENDENCY_VERSION_INCOMPATIBLE'
      && error?.actualVersion === '1.9.9',
  )
  assert.equal(assertPluginCompatibility(dependent, {
    hostVersion: '0.11.31',
    resolveDependencyVersion: () => '2.4.0',
  }), true)
})
