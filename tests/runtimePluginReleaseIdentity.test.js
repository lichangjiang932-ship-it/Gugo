import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  buildRuntimePluginReleaseContentIdentity,
  verifyRuntimePluginReleaseContentIdentity,
} from '../server/plugins/runtimePluginReleaseIdentity.js'

const SOURCE = 'function transform(input) { return input }'

function sourceDigest(source) {
  return `sha256-${createHash('sha256').update(source).digest('hex')}`
}

function release(snapshot, overrides = {}) {
  const source = overrides.source ?? SOURCE
  return {
    releaseId: 'rel-deterministic-test',
    pluginId: 'identity-transformer',
    sourceDigest: sourceDigest(source),
    source,
    pluginSnapshotJson: JSON.stringify(snapshot),
    validationStatus: 'passed',
    healthStatus: 'passed',
    failure: null,
    createdAt: 10,
    ...overrides,
  }
}

const SNAPSHOT = {
  id: 'identity-transformer',
  name: 'Identity Transformer',
  version: '1.2.3',
  type: 'transformer',
  entry: 'entry.js',
  description: 'Deterministic identity test',
  author: 'Local author',
  license: 'MIT',
  tags: ['local'],
  requires: ['local-base'],
  contributes: ['prompt:identity'],
  capabilities: [],
  permissions: ['local.read'],
  dependencyVersions: { 'local-base': '^1.0.0' },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      label: { type: 'string' },
    },
  },
  stateSchemaVersion: 1,
  futureSnapshotData: { audit: true },
}

test('release content identity is canonical across object key ordering', () => {
  const reordered = {
    futureSnapshotData: { audit: true },
    stateSchemaVersion: 1,
    configSchema: {
      properties: {
        label: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      type: 'object',
    },
    dependencyVersions: { 'local-base': '^1.0.0' },
    permissions: ['local.read'],
    capabilities: [],
    contributes: ['prompt:identity'],
    requires: ['local-base'],
    tags: ['local'],
    license: 'MIT',
    author: 'Local author',
    description: 'Deterministic identity test',
    entry: 'entry.js',
    type: 'transformer',
    version: '1.2.3',
    name: 'Identity Transformer',
    id: 'identity-transformer',
  }
  assert.equal(
    buildRuntimePluginReleaseContentIdentity(release(SNAPSHOT)).releaseContentDigest,
    buildRuntimePluginReleaseContentIdentity(release(reordered)).releaseContentDigest,
  )
})

test('release content identity covers source, manifest, capabilities, and full snapshot data', () => {
  const baseline = buildRuntimePluginReleaseContentIdentity(release(SNAPSHOT))
  const variants = [
    release(SNAPSHOT, {
      source: `${SOURCE}\n// changed`,
      sourceDigest: sourceDigest(`${SOURCE}\n// changed`),
    }),
    release({ ...SNAPSHOT, version: '1.2.4' }),
    release({ ...SNAPSHOT, capabilities: ['log'] }),
    release({ ...SNAPSHOT, futureSnapshotData: { audit: false } }),
  ]
  for (const variant of variants) {
    assert.notEqual(
      buildRuntimePluginReleaseContentIdentity(variant).releaseContentDigest,
      baseline.releaseContentDigest,
    )
  }

  assert.equal(verifyRuntimePluginReleaseContentIdentity({
    ...release(SNAPSHOT),
    releaseContentDigest: baseline.releaseContentDigest,
    digestVersion: baseline.digestVersion,
  }).releaseContentDigest, baseline.releaseContentDigest)
  assert.throws(
    () => verifyRuntimePluginReleaseContentIdentity({
      ...release({ ...SNAPSHOT, capabilities: ['log'] }),
      releaseContentDigest: baseline.releaseContentDigest,
      digestVersion: baseline.digestVersion,
    }),
    (error) => error?.code === 'PLUGIN_RELEASE_CORRUPT',
  )
})
