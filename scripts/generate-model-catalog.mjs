#!/usr/bin/env node
/**
 * Builds `shared/modelCatalogSnapshot.json` from the models.dev catalogue.
 *
 * Why a generated snapshot at all, rather than only fetching at runtime:
 *
 * - This app is local-first and its tests are offline and deterministic
 *   (AGENTS.md §8). A provider catalogue that exists only behind a network call
 *   would make first run, offline use, and the whole test suite depend on a
 *   third party.
 * - The previous arrangement was the opposite failure: a hand-maintained list of
 *   provider presets whose model ids drift out of date the moment a vendor ships
 *   a model. That drift is what the snapshot replaces.
 *
 * So the snapshot is the offline baseline and the runtime is allowed to refresh
 * it from models.dev when the reader asks. Both paths validate against the same
 * contract in `shared/modelCatalogSnapshot.js`.
 *
 * The compaction and validation live in `shared/` because the server imports
 * them at runtime and the desktop package ships `shared/` but not `scripts/`.
 *
 *   node scripts/generate-model-catalog.mjs               # fetch and write
 *   node scripts/generate-model-catalog.mjs --from <file>  # build from a local copy
 *   node scripts/generate-model-catalog.mjs --validate     # offline check (CI gate)
 *   node scripts/generate-model-catalog.mjs --check        # fail if the snapshot is stale
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CATALOG_SOURCE_URL,
  buildSnapshot,
  isUsableSnapshot,
} from '../shared/modelCatalogSnapshot.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
export const SNAPSHOT_PATH = path.join(ROOT, 'shared', 'modelCatalogSnapshot.json')

async function fetchCatalogue() {
  // `--from <file>` builds the snapshot from a local copy of the upstream
  // document, which is how CI and this repo's own maintenance stay off the
  // network and reproducible.
  const fromIndex = process.argv.indexOf('--from')
  if (fromIndex !== -1 && process.argv[fromIndex + 1]) {
    return JSON.parse(fs.readFileSync(process.argv[fromIndex + 1], 'utf8'))
  }
  const response = await fetch(CATALOG_SOURCE_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`models.dev responded ${response.status}`)
  return response.json()
}

function readCurrent() {
  try {
    return fs.readFileSync(SNAPSHOT_PATH, 'utf8')
  } catch {
    return ''
  }
}

/** Offline gate: the committed snapshot exists and still matches the contract. */
function validateSnapshot() {
  let parsed = null
  try {
    parsed = JSON.parse(readCurrent())
  } catch (error) {
    process.stderr.write(`[model-catalog] cannot read the snapshot: ${error?.message || error}\n`)
    process.exitCode = 1
    return
  }
  if (!isUsableSnapshot(parsed)) {
    process.stderr.write('[model-catalog] the snapshot does not match the expected shape\n')
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `[model-catalog] snapshot ok: ${parsed.providerCount} providers, ${parsed.modelCount} models, generated ${parsed.generatedAt}\n`,
  )
}

async function main() {
  if (process.argv.includes('--validate')) return validateSnapshot()

  const snapshot = buildSnapshot(await fetchCatalogue())
  const serialised = `${JSON.stringify(snapshot, null, 2)}\n`

  // `--check` compares against a live fetch. That is a maintenance task, not a
  // build gate: it needs the network and fails on upstream churn rather than on
  // anything this repo did wrong.
  if (process.argv.includes('--check')) {
    if (readCurrent() === serialised) {
      process.stdout.write(`[model-catalog] snapshot is current (${snapshot.providerCount} providers, ${snapshot.modelCount} models)\n`)
      return
    }
    process.stderr.write('[model-catalog] snapshot is out of date; run: npm run catalog:generate\n')
    process.exitCode = 1
    return
  }

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true })
  fs.writeFileSync(SNAPSHOT_PATH, serialised)
  const kb = (Buffer.byteLength(serialised) / 1024).toFixed(0)
  process.stdout.write(
    `[model-catalog] wrote ${snapshot.providerCount} providers / ${snapshot.modelCount} models (${kb} KB) to shared/modelCatalogSnapshot.json\n`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`[model-catalog] ${error?.message || error}\n`)
    process.exitCode = 1
  })
}
