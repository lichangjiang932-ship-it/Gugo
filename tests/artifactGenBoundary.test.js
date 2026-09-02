import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as artifactDelivery from '../server/services/artifactDelivery.js'
import * as artifactGen from '../server/services/artifactGen.js'
import * as artifactLocalPublication from '../server/services/artifactLocalPublication.js'
import * as artifactStorage from '../server/services/artifactStorage.js'
import * as htmlArtifactFormat from '../server/services/htmlArtifactFormat.js'
import {
  collectStaticModuleGraph,
  extractStaticModuleLoads,
} from './helpers/staticModuleGraph.js'

const artifactGenPath = fileURLToPath(new URL('../server/services/artifactGen.js', import.meta.url))
const serviceDirectory = path.dirname(artifactGenPath)

const APPROVED_DIRECT_LOADS = Object.freeze([
  './artifactAtomicWriter.js',
  './artifactDelivery.js',
  './artifactLocalPublication.js',
  './artifactLocalPublicationPaths.js',
  './artifactStorage.js',
  './docxArtifactFormat.js',
  './htmlArtifactFormat.js',
  './officeArtifactImages.js',
  './pdfArtifactFormat.js',
  './pptxArtifactFormat.js',
  './xlsxArtifactContract.js',
  './xlsxArtifactFormat.js',
  'node:crypto',
])

const FOCUSED_ARTIFACT_SERVICES = Object.freeze([
  'artifactAtomicWriter.js',
  'artifactDelivery.js',
  'artifactHtmlPreviewService.js',
  'artifactLocalPublication.js',
  'artifactLocalPublicationPaths.js',
  'artifactSourceStore.js',
  'artifactStorage.js',
  'docxArtifactFormat.js',
  'htmlArtifactFormat.js',
  'officeArtifactImages.js',
  'pdfArtifactFormat.js',
  'pptxArtifactFormat.js',
  'xlsxArtifactContract.js',
  'xlsxArtifactFormat.js',
])

test('artifactGen preserves delegated export identity through its compatibility facade', () => {
  assert.strictEqual(artifactGen.MAX_HTML_ARTIFACT_BYTES, htmlArtifactFormat.MAX_HTML_ARTIFACT_BYTES)
  assert.strictEqual(artifactGen.validateHtmlArtifactSource, htmlArtifactFormat.validateHtmlArtifactSource)
  assert.strictEqual(artifactGen.createLocalFileArtifact, artifactLocalPublication.createLocalFileArtifact)
  assert.strictEqual(artifactGen.createLocalFileArtifactAsync, artifactLocalPublication.createLocalFileArtifactAsync)
  assert.strictEqual(artifactGen.getArtifactPreviewRendererStatus, artifactDelivery.getArtifactPreviewRendererStatus)
  assert.strictEqual(artifactGen.handleArtifactDownload, artifactDelivery.handleArtifactDownload)
  assert.strictEqual(artifactGen.renderArtifactPreviewPng, artifactDelivery.renderArtifactPreviewPng)
  assert.strictEqual(artifactGen.getArtifactDir, artifactStorage.getArtifactDir)
})

test('artifactGen remains a thin host facade with an explicit direct dependency boundary', () => {
  const source = fs.readFileSync(artifactGenPath, 'utf8')
  const moduleLoads = extractStaticModuleLoads(source, { file: artifactGenPath })

  assert.ok(source.split(/\r?\n/u).length <= 300, 'Keep the artifact compatibility facade below 300 lines')
  assert.deepEqual(moduleLoads.unresolvedLoads, [], 'artifactGen module loads must remain statically reviewable')
  assert.deepEqual(
    [...new Set(moduleLoads.loads.map(({ specifier }) => specifier))].sort(),
    [...APPROVED_DIRECT_LOADS].sort(),
    'New artifactGen dependencies require an explicit host-boundary review',
  )
})

test('focused artifact services do not depend back on the compatibility facade', () => {
  for (const filename of FOCUSED_ARTIFACT_SERVICES) {
    const entry = path.join(serviceDirectory, filename)
    const graph = collectStaticModuleGraph(entry)
    assert.equal(
      graph.files.has(artifactGenPath),
      false,
      `${filename} must not directly or transitively import artifactGen.js`,
    )
  }
})
