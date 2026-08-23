#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function isSeedSystemSkillsMainEntry(argv = process.argv) {
  const entry = argv[1]
  if (!entry) return false
  return pathToFileURL(path.resolve(entry)).href === import.meta.url
}

export async function runSeedSystemSkillsProcess({
  cwd = process.cwd(),
  env = process.env,
} = {}, dependencies = {}) {
  const preflight = dependencies.runRuntimeConfigStartupPreflight || (
    await import('./services/runtimeConfigStartupService.js')
  ).runRuntimeConfigStartupPreflight
  const { runtimeEnv } = preflight({ cwd, env })
  const seed = dependencies.seedSystemSkills || (
    await import('./services/seedSystemSkills.js')
  ).seedSystemSkills
  const close = dependencies.closeDb || (await import('./db.js')).closeDb

  let results
  try {
    results = seed({ silent: true })
  } finally {
    close()
  }
  const failures = results.filter((entry) => entry?.status === 'error')
  return Object.freeze({
    ok: failures.length === 0,
    exitCode: failures.length === 0 ? 0 : 1,
    results: Object.freeze(results),
    runtimeEnv,
  })
}

if (isSeedSystemSkillsMainEntry()) {
  try {
    const result = await runSeedSystemSkillsProcess()
    process.stdout.write(`${JSON.stringify({ ok: result.ok, results: result.results })}\n`)
    process.exitCode = result.exitCode
  } catch (error) {
    process.stderr.write(`[seed:skills] failed: ${error?.stack || error}\n`)
    process.exitCode = 1
  }
}
