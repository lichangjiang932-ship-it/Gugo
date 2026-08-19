import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getDynamicTool,
  getBuiltinSpec,
  getToolMetadata,
  listBuiltinNames,
  registerDynamicTool,
  resolveSpecsForMode,
  unregisterDynamicTool,
} from '../server/services/toolRegistry.js'

const spec = { type: 'function', function: { name: 'read_user_data', parameters: { type: 'object', properties: {} } } }

test('dynamic tools default to approval-required external risk', () => {
  registerDynamicTool({ name: 'read_user_data', origin: 'mcp', spec })
  try {
    const metadata = getDynamicTool('read_user_data').metadata
    assert.equal(metadata.riskClass, 'external')
    assert.equal(metadata.category, 'external')
    assert.equal(metadata.riskLevel, 'high')
    assert.equal(metadata.requiredApproval, true)
    assert.equal(metadata.requiresApproval, true)
    assert.equal(metadata.isReadOnly, false)
    assert.equal(metadata.isConcurrencySafe, false)
    assert.equal(metadata.interruptBehavior, 'block')
    assert.equal(metadata.isDestructive, true)
    assert.equal(typeof metadata.getPath, 'function')
    assert.equal(metadata.origin, 'mcp')
    assert.equal(metadata.source, 'fallback')
  } finally { unregisterDynamicTool('read_user_data') }
})

test('explicit read-only metadata is preserved', () => {
  registerDynamicTool({ name: 'safe_lookup', origin: 'connector', spec, metadata: { riskClass: 'read' } })
  try {
    assert.equal(getDynamicTool('safe_lookup').metadata.requiresApproval, false)
    assert.equal(getDynamicTool('safe_lookup').metadata.readOnly, true)
    assert.equal(getDynamicTool('safe_lookup').metadata.isConcurrencySafe, true)
    assert.equal(getDynamicTool('safe_lookup').metadata.interruptBehavior, 'cancel')
    assert.equal(getDynamicTool('safe_lookup').metadata.riskLevel, 'low')
    assert.equal(getDynamicTool('safe_lookup').metadata.category, 'read')
    assert.equal(getDynamicTool('safe_lookup').metadata.source, 'declared')
  } finally { unregisterDynamicTool('safe_lookup') }
})

test('every builtin spec carries a complete explicit risk declaration', () => {
  const names = listBuiltinNames()
  assert.equal(names.length, 55)
  for (const name of names) {
    const spec = getBuiltinSpec(name)
    assert.ok(spec?.metadata, `${name} metadata`)
    assert.ok(['low', 'medium', 'high'].includes(spec.metadata.riskLevel), `${name} riskLevel`)
    assert.equal(typeof spec.metadata.requiredApproval, 'boolean', `${name} requiredApproval`)
    assert.ok(['read', 'write_local', 'exec', 'external'].includes(spec.metadata.category), `${name} category`)
    assert.equal(typeof spec.metadata.isConcurrencySafe, 'boolean', `${name} concurrency`)
    assert.equal(getToolMetadata(name).source, 'declared', `${name} source`)
  }
})

test('requiredApproval alias is normalized without breaking legacy consumers', () => {
  registerDynamicTool({
    name: 'declared_external_lookup',
    origin: 'mcp',
    spec,
    metadata: {
      riskLevel: 'medium',
      category: 'external',
      requiredApproval: false,
      isConcurrencySafe: false,
    },
  })
  try {
    const metadata = getToolMetadata('declared_external_lookup')
    assert.equal(metadata.requiredApproval, false)
    assert.equal(metadata.requiresApproval, false)
    assert.equal(metadata.riskClass, 'external')
    assert.equal(metadata.source, 'declared')
  } finally { unregisterDynamicTool('declared_external_lookup') }
})

test('unknown tools use the fail-closed fallback', () => {
  const metadata = getToolMetadata('not_registered_anywhere')
  assert.equal(metadata.category, 'external')
  assert.equal(metadata.riskLevel, 'high')
  assert.equal(metadata.requiresApproval, true)
  assert.equal(metadata.source, 'fallback')
})

test('builtin metadata derives shell read-only and path semantics per call', () => {
  const directory = getToolMetadata('list_directory', { args: { path: '.' } })
  assert.equal(directory.riskClass, 'read')
  assert.equal(directory.isReadOnly, true)
  assert.equal(directory.isConcurrencySafe, true)
  assert.equal(directory.requiresApproval, false)
  assert.equal(directory.source, 'declared')

  const read = getToolMetadata('bash_exec', { args: { command: 'git status', cwd: 'src' } })
  assert.equal(read.riskClass, 'read')
  assert.equal(read.isReadOnly, true)
  assert.equal(read.isConcurrencySafe, true)
  assert.equal(read.getPath({ cwd: 'src' }), 'src')

  const write = getToolMetadata('bash_exec', { args: { command: 'npm test' } })
  assert.equal(write.riskClass, 'exec')
  assert.equal(write.isReadOnly, false)
  assert.equal(write.interruptBehavior, 'block')

  const ambiguousRunner = getToolMetadata('run_command', { args: { command: 'git status' } })
  assert.equal(ambiguousRunner.riskClass, 'exec')
  assert.equal(ambiguousRunner.isReadOnly, false)
  assert.equal(ambiguousRunner.requiresApproval, true)

  const reflect = getToolMetadata('reflect')
  assert.equal(reflect.isReadOnly, true)
  assert.equal(reflect.isConcurrencySafe, false, 'loop-control tools must remain ordered')
})

test('PDF/archive metadata stays accurate while plan mode keeps the full catalog visible', () => {
  const metadata = getToolMetadata('pdf_text')
  assert.equal(metadata.riskClass, 'read')
  assert.equal(metadata.isReadOnly, true)
  assert.equal(metadata.isConcurrencySafe, true)
  assert.equal(metadata.requiresApproval, false)

  const archiveMetadata = getToolMetadata('archive_list')
  assert.equal(archiveMetadata.riskClass, 'read')
  assert.equal(archiveMetadata.isReadOnly, true)
  assert.equal(archiveMetadata.isConcurrencySafe, true)
  assert.equal(archiveMetadata.requiresApproval, false)

  const planNames = resolveSpecsForMode('plan').map((entry) => entry.name)
  assert.ok(planNames.includes('pdf_info'))
  assert.ok(planNames.includes('pdf_text'))
  assert.ok(planNames.includes('archive_list'))
  assert.ok(planNames.includes('pdf_transform'))
})

test('set_deliverables remains catalog-visible in plan mode but is classified as non-read-only', () => {
  const metadata = getToolMetadata('set_deliverables')
  assert.equal(metadata.isReadOnly, false)
  assert.equal(metadata.isConcurrencySafe, false)
  assert.equal(metadata.isIdempotent, true)
  assert.equal(metadata.requiresApproval, false)
  assert.equal(metadata.isDestructive, false)

  const planNames = resolveSpecsForMode('plan').map((entry) => entry.name)
  const codeNames = resolveSpecsForMode('code').map((entry) => entry.name)
  assert.equal(planNames.includes('set_deliverables'), true)
  assert.equal(codeNames.includes('set_deliverables'), true)
})

test('plan mode does not hide dynamic tools from the catalog', () => {
  registerDynamicTool({ name: 'plan_visible_external', origin: 'mcp', spec })
  try {
    const planNames = resolveSpecsForMode('plan').map((entry) => entry.name)
    assert.ok(planNames.includes('plan_visible_external'))
  } finally {
    unregisterDynamicTool('plan_visible_external')
  }
})
