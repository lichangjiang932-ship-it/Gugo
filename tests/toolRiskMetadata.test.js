import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getDynamicTool,
  getToolMetadata,
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
    assert.equal(metadata.requiresApproval, true)
    assert.equal(metadata.isReadOnly, false)
    assert.equal(metadata.isConcurrencySafe, false)
    assert.equal(metadata.interruptBehavior, 'block')
    assert.equal(metadata.isDestructive, true)
    assert.equal(typeof metadata.getPath, 'function')
    assert.equal(metadata.origin, 'mcp')
  } finally { unregisterDynamicTool('read_user_data') }
})

test('explicit read-only metadata is preserved', () => {
  registerDynamicTool({ name: 'safe_lookup', origin: 'connector', spec, metadata: { riskClass: 'read' } })
  try {
    assert.equal(getDynamicTool('safe_lookup').metadata.requiresApproval, false)
    assert.equal(getDynamicTool('safe_lookup').metadata.readOnly, true)
    assert.equal(getDynamicTool('safe_lookup').metadata.isConcurrencySafe, true)
    assert.equal(getDynamicTool('safe_lookup').metadata.interruptBehavior, 'cancel')
  } finally { unregisterDynamicTool('safe_lookup') }
})

test('builtin metadata derives shell read-only and path semantics per call', () => {
  const directory = getToolMetadata('list_directory', { args: { path: '.' } })
  assert.equal(directory.riskClass, 'read')
  assert.equal(directory.isReadOnly, true)
  assert.equal(directory.isConcurrencySafe, true)
  assert.equal(directory.requiresApproval, false)

  const read = getToolMetadata('bash_exec', { args: { command: 'git status', cwd: 'src' } })
  assert.equal(read.riskClass, 'read')
  assert.equal(read.isReadOnly, true)
  assert.equal(read.isConcurrencySafe, true)
  assert.equal(read.getPath({ cwd: 'src' }), 'src')

  const write = getToolMetadata('bash_exec', { args: { command: 'npm test' } })
  assert.equal(write.riskClass, 'exec')
  assert.equal(write.isReadOnly, false)
  assert.equal(write.interruptBehavior, 'block')

  const reflect = getToolMetadata('reflect')
  assert.equal(reflect.isReadOnly, true)
  assert.equal(reflect.isConcurrencySafe, false, 'loop-control tools must remain ordered')
})

test('PDF/archive inspection tools are read-only, concurrency-safe, and available in plan mode', () => {
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
  assert.ok(!planNames.includes('pdf_transform'))
})
