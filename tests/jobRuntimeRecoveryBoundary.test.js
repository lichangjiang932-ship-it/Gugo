import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const jobRuntimeSource = readFileSync(
  new URL('../server/services/jobRuntime.js', import.meta.url),
  'utf8',
)
const recoverySource = readFileSync(
  new URL('../server/services/jobRuntimeRecovery.js', import.meta.url),
  'utf8',
)
const eventHubSource = readFileSync(
  new URL('../server/services/jobRuntimeEventHub.js', import.meta.url),
  'utf8',
)
const commandSource = readFileSync(
  new URL('../server/services/jobRuntimeCommands.js', import.meta.url),
  'utf8',
)
const tickSource = readFileSync(
  new URL('../server/services/jobRuntimeTick.js', import.meta.url),
  'utf8',
)
const tickDependenciesSource = readFileSync(
  new URL('../server/services/jobRuntimeTickDependencies.js', import.meta.url),
  'utf8',
)
const defaultPlannerSource = readFileSync(
  new URL('../server/services/jobRuntimeDefaultPlanner.js', import.meta.url),
  'utf8',
)

test('job runtime delegates default planning composition to a focused provider', () => {
  assert.match(jobRuntimeSource, /createDefaultJobPlanner\(\)/u)
  assert.doesNotMatch(defaultPlannerSource, /from ['"]\.\/jobRuntime\.js['"]/u)

  for (const concreteDependency of [
    './jobPlanner.js',
    './jobPlanningExplorationRuntime.js',
    './jobModelExecutionRuntime.js',
  ]) {
    assert.equal(
      jobRuntimeSource.split(/\r?\n/u).some((line) => (
        line.startsWith('import ') && line.includes(concreteDependency)
      )),
      false,
      `jobRuntime.js must not directly import planner dependency: ${concreteDependency}`,
    )
    assert.equal(
      defaultPlannerSource.includes(concreteDependency),
      true,
      `default planner provider must retain composition: ${concreteDependency}`,
    )
  }
})

test('job runtime delegates concrete tick dependencies to a focused provider', () => {
  assert.equal(
    jobRuntimeSource.includes(
      "import { DEFAULT_JOB_RUNTIME_TICK_DEPENDENCIES } from './jobRuntimeTickDependencies.js'",
    ),
    true,
  )
  assert.match(
    jobRuntimeSource,
    /runJobRuntimeTick\.call\(this, DEFAULT_JOB_RUNTIME_TICK_DEPENDENCIES\)/u,
  )
  assert.match(tickDependenciesSource, /Object\.freeze\(\{/u)
  assert.doesNotMatch(tickDependenciesSource, /from ['"]\.\/jobRuntime\.js['"]/u)

  for (const concreteDependency of [
    './jobWakeStore.js',
    './jobSteeringStore.js',
    './notificationsStore.js',
    './hooksService.js',
  ]) {
    assert.equal(
      jobRuntimeSource.includes(concreteDependency),
      false,
      `jobRuntime.js must not directly compose tick dependency: ${concreteDependency}`,
    )
    assert.equal(
      tickDependenciesSource.includes(concreteDependency),
      true,
      `tick dependency provider must retain composition: ${concreteDependency}`,
    )
  }
})

test('job runtime delegates crash recovery to the focused recovery service', () => {
  assert.match(jobRuntimeSource, /recoverRuntimeJobs\(\{/u)

  for (const forbidden of [
    'getLatestJobApproval',
    'releaseAllJobSteeringLeases',
    'JOB_PROCESS_RESTART_RECOVERED',
    'JOB_APPROVAL_RECOVERED',
  ]) {
    assert.equal(
      jobRuntimeSource.includes(forbidden),
      false,
      `jobRuntime.js must not reclaim recovery responsibility: ${forbidden}`,
    )
    assert.equal(
      recoverySource.includes(forbidden),
      true,
      `jobRuntimeRecovery.js must retain recovery responsibility: ${forbidden}`,
    )
  }
})

test('job recovery remains fenced by a short execution lease', () => {
  assert.match(recoverySource, /lease\.isActive\(scope\)/u)
  assert.match(recoverySource, /lease\.acquire\(scope\)/u)
  assert.match(recoverySource, /lease\.runIfOwned\(scope,/u)
  assert.match(recoverySource, /recoveryLease\.release\(\)/u)
})

test('job owner caching and tenant event delivery stay behind the focused event hub', () => {
  assert.match(jobRuntimeSource, /createJobRuntimeEventHub\(\{/u)
  assert.match(eventHubSource, /const jobOwners = new Map\(\)/u)
  assert.match(eventHubSource, /const listeners = new Map\(\)/u)

  for (const [name, source] of [
    ['job runtime facade', jobRuntimeSource],
    ['job runtime commands', commandSource],
    ['job runtime tick', tickSource],
  ]) {
    assert.equal(
      source.includes('jobUserCache'),
      false,
      `${name} must use the event hub instead of owning its cache`,
    )
  }
  assert.equal(jobRuntimeSource.includes('this.listeners'), false)
  assert.match(commandSource, /runtime\.cacheJobOwner\(id, userId\)/u)
  assert.match(tickSource, /this\.cacheJobOwner\(wake\.jobId, wake\.userId\)/u)
})
