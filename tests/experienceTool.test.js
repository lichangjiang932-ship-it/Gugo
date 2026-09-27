import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { EXPERIENCE_TOOL_NAMES, EXPERIENCE_TOOL_SPECS } from '../server/utils/experienceTools.js'
import { experienceJournalPath } from '../server/services/experienceJournal.js'
import { closeDb, createUser } from '../server/db.js'
import { setApprovalMode } from '../server/services/approvalSettingsStore.js'

let workspace
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}
const USER = 'experience-tool-user'

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-experience-tool-'))
  process.env.APP_DB_PATH = path.join(workspace, 'experience-tool-test.db')
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_FS_ENABLED = '1'
  process.env.WORKSPACE_SHARED_TRUSTED = '1'
})

after(() => {
  closeDb()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(workspace, { recursive: true, force: true })
})

beforeEach(() => {
  closeDb()
  fs.rmSync(process.env.APP_DB_PATH, { force: true })
  createUser({ id: USER, email: 'experience-tool@example.com' })
  setApprovalMode({ userId: USER, mode: 'normal' })
  fs.rmSync(experienceJournalPath(workspace), { force: true })
})

const args = (overrides = {}) => ({
  goal: '让侧栏浏览器能打开禁止嵌入的站点',
  blocker: 'iframe 被拒时没有任何事件',
  solution: '桌面端换 WebContentsView',
  evidence: 'turn-1;src/components/EmbeddedBrowser.jsx',
  topic: 'sidebar-browser',
  ...overrides,
})

test('the tool is registered in the catalog the model is actually sent', async () => {
  // Importing the catalog also runs the metadata-parity check, which throws when a
  // builtin has no metadata entry — so this import is itself the boot guard. A spec
  // that exists in its own module but is not in the catalog would never reach the
  // model at all.
  const { getBuiltinSpec, listBuiltinNames } = await import('../server/utils/toolSchemaCatalog.js')
  const names = listBuiltinNames()
  for (const name of EXPERIENCE_TOOL_NAMES) {
    assert.equal(names.includes(name), true, `${name} must be in the builtin catalog`)
    assert.ok(getBuiltinSpec(name)?.function?.description, `${name} must carry a model-facing description`)
  }
  assert.deepEqual(EXPERIENCE_TOOL_NAMES, ['record_experience'])
})

test('the host schema rejects a call the model should not be able to make', async () => {
  const { validateToolSchemaArguments } = await import('../server/utils/toolJsonSchema.js')
  const schema = EXPERIENCE_TOOL_SPECS[0].function.parameters

  assert.equal(validateToolSchemaArguments(args(), schema), null)
  const missing = validateToolSchemaArguments({ solution: 's', evidence: 'e' }, schema)
  assert.equal(missing?.code, 'tool_arguments_validation_failed', 'goal is required')
  // additionalProperties:false keeps an invented field from being silently dropped
  // on the floor, which would let the model believe it recorded something it did not.
  const extra = validateToolSchemaArguments({ ...args(), severity: 'high' }, schema)
  assert.equal(extra?.code, 'tool_arguments_validation_failed', 'unknown fields are refused')
  const badScope = validateToolSchemaArguments({ ...args(), scope: 'global' }, schema)
  assert.equal(badScope?.code, 'tool_arguments_validation_failed', 'scope is a closed enum')
})

test('a dispatched episode is written to the workspace journal and reported back', async () => {
  const { dispatchExperienceTool } = await import('../server/utils/experienceTools.js')
  const result = await dispatchExperienceTool('record_experience', args(), { userId: USER, sessionId: 'session-1' })

  assert.equal(result.ok, true, result.error)
  assert.match(result.summary, /已记录经验 exp-/u)
  assert.equal(result.pendingExperienceCount, 1)
  // The session is folded into the evidence trail, so an episode is traceable even
  // when the model supplied only its own description of the evidence.
  const written = fs.readFileSync(result.journalPath, 'utf8')
  assert.match(written, /session-1/u)
  assert.match(written, /桌面端换 WebContentsView/u)
})

test('the tool refuses a missing user instead of writing a shared journal', async () => {
  const { dispatchExperienceTool } = await import('../server/utils/experienceTools.js')
  const result = await dispatchExperienceTool('record_experience', args(), { userId: null })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'EXPERIENCE_NO_USER')
})

test('an unknown experience tool name throws rather than silently succeeding', async () => {
  const { dispatchExperienceTool } = await import('../server/utils/experienceTools.js')
  await assert.rejects(
    () => dispatchExperienceTool('record_something_else', {}, { userId: USER }),
    /unknown experience tool/u,
  )
})

test('recording an episode is never something the user has to approve', async () => {
  // Approval spam is the failure mode this guards: the journal is written on most
  // turns, and a prompt on every turn trains reflexive approval.
  const { classifyToolRisk } = await import('../server/utils/approvalPolicy.js')
  const verdict = classifyToolRisk('record_experience', args())
  assert.equal(verdict.needsApproval, false)
  assert.equal(verdict.denied, undefined)
  // It is still a local write, not a read: it must not be advertised as harmless.
  const { getToolMetadata } = await import('../server/utils/toolSchemaCatalog.js')
  const metadata = getToolMetadata('record_experience')
  assert.equal(metadata.requiredApproval, false)
  assert.equal(metadata.executionMode, 'exclusive')
  assert.equal(metadata.isDestructive, false)
})

test('recording an episode does not demand a verification pass', async () => {
  // The journal is bookkeeping, not a change to the user's project. If it were
  // treated as a local mutation, every recorded episode would force the agent to
  // prove it by re-reading files before it could finish.
  const { LOCAL_MUTATION_TOOLS } = await import('../server/services/loop/heuristics/constants.js')
  assert.equal(LOCAL_MUTATION_TOOLS.has('record_experience'), false)
})
