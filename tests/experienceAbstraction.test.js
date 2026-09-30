import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  abstractionDue,
  abstractExperienceJournal,
  buildExperienceAbstractionMessages,
  parseExperienceAbstraction,
  resetExperienceAbstractionCooldown,
} from '../server/services/experienceAbstraction.js'
import { readExperienceJournal, recordExperience } from '../server/services/experienceRecorder.js'
import { experienceJournalPath, parseExperienceJournal } from '../server/services/experienceJournal.js'
import { MIN_CONFIDENCE } from '../server/services/autoMemoryService.js'
import { closeDb, createUser } from '../server/db.js'
import { listMemories } from '../server/services/memoryStore.js'
import { setApprovalMode } from '../server/services/approvalSettingsStore.js'

let workspace
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}
const USER = 'experience-abstraction-user'

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-experience-abstraction-'))
  process.env.APP_DB_PATH = path.join(workspace, 'experience-abstraction-test.db')
  process.env.WORKSPACE_ROOT = workspace
  process.env.WORKSPACE_FS_ENABLED = '1'
  // The journal is a real file in the workspace, so it needs the same authority
  // any other workspace write needs.
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
  fs.rmSync(experienceJournalPath(workspace), { force: true })
  fs.rmSync(path.join(path.dirname(experienceJournalPath(workspace)), 'experience.archive.md'), { force: true })
  createUser({ id: USER, email: 'experience-abstraction@example.com' })
  setApprovalMode({ userId: USER, mode: 'normal' })
  resetExperienceAbstractionCooldown()
})

const episode = (overrides = {}) => ({
  topic: 'pptx-verification',
  scope: 'project',
  evidence: 'turn-1;out/probe.pptx',
  goal: '生成一份 5 页产品介绍 PPT',
  solution: 'python-pptx 生成后用 readback 校验页数与字体',
  ...overrides,
})

async function seedJournal(count, overrides = {}) {
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const result = await recordExperience({
      userId: USER,
      workspaceRoot: workspace,
      episode: episode({
        topic: `topic-${index}`,
        goal: `第 ${index} 件事`,
        solution: `第 ${index} 种解法`,
        evidence: `turn-${index}`,
        ...overrides,
      }),
      // Spreading the entries over time keeps `when` realistic for the age test.
      now: Date.now() - index * 1000,
    })
    assert.equal(result.ok, true, result.error)
    ids.push(result.entry.id)
  }
  return ids
}

const ENTRY = {
  id: 'exp-20260101-001',
  when: '2026-01-01T00:00:00.000Z',
  topic: 'pptx',
  scope: 'project',
  status: 'pending',
  evidence: 'turn-1',
  goal: '做一份 PPT',
  solution: 'readback 校验',
}

test('the journal earns a model call on volume, on age, or not yet', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ ...ENTRY, id: `exp-${index}` }))
  assert.deepEqual(
    { due: abstractionDue(many).due, reason: abstractionDue(many).reason },
    { due: true, reason: 'entries' },
  )
  // Volume counts bytes too: a handful of long episodes can be worth one call.
  const fat = [{
    ...ENTRY,
    solution: 'x'.repeat(32 * 1024),
  }]
  assert.equal(abstractionDue(fat).reason, 'bytes')
  // One old episode is worth generalizing on its own; the clock is what triggers.
  const old = [{ ...ENTRY, when: new Date(Date.now() - 8 * 86_400_000).toISOString() }]
  assert.equal(abstractionDue(old).reason, 'age')

  // Written today: recent enough that only volume would justify a call.
  const fresh = [{ ...ENTRY, when: new Date().toISOString() }]
  assert.deepEqual(
    { due: abstractionDue(fresh).due, reason: abstractionDue(fresh).reason },
    { due: false, reason: 'below_threshold' },
  )
  assert.equal(abstractionDue([]).reason, 'empty')
  // Already consumed entries never trigger another run.
  assert.equal(abstractionDue([{ ...ENTRY, status: 'digested' }]).reason, 'empty')
})

test('the prompt carries the pending episodes and the ids an answer must cite', () => {
  const entries = [
    { ...ENTRY, id: 'exp-a' },
    { ...ENTRY, id: 'exp-b', status: 'digested' },
    { ...ENTRY, id: 'exp-c' },
  ]
  const { messages, consumedEntryIds } = buildExperienceAbstractionMessages(entries)
  assert.deepEqual(consumedEntryIds, ['exp-a', 'exp-c'])
  const payload = JSON.parse(messages[1].content)
  assert.deepEqual(payload.entries.map((entry) => entry.id), ['exp-a', 'exp-c'])
  assert.equal(payload.entries[0].goal, '做一份 PPT')
  assert.match(messages[0].content, /sources/)
})

test('an abstraction is only believed where it cites a real episode', () => {
  const knownEntryIds = new Set(['exp-a', 'exp-b'])
  const parsed = parseExperienceAbstraction(`\`\`\`json
{
  "longTerm": [
    { "type": "user", "title": "偏好", "body": "喜欢先看结论", "confidence": 0.9, "sources": ["exp-a"] },
    { "type": "user", "title": "无出处", "body": "凭空", "confidence": 0.9, "sources": [] },
    { "type": "user", "title": "假出处", "body": "编的 id", "confidence": 0.9, "sources": ["exp-nope"] }
  ],
  "project": [
    { "title": "构建", "body": "必须 npm run build", "confidence": 0.85, "sources": ["exp-b"] }
  ],
  "skills": [
    { "name": "pptx-readback", "description": "生成后回读校验", "trigger": "产出 pptx 时", "steps": ["生成", "回读页数"], "sources": ["exp-b"] },
    { "name": "no-sources", "description": "没有出处", "trigger": "任何时候", "steps": ["做"], "sources": [] }
  ]
}
\`\`\``, { knownEntryIds })

  assert.deepEqual(parsed.longTerm.map((item) => item.title), ['偏好'])
  // A project item can never claim to be user-level knowledge: the section decides.
  assert.equal(parsed.project[0].type, 'project')
  assert.equal(parsed.skills.length, 1)
  assert.equal(parsed.skills[0].title, 'pptx-readback')
  assert.deepEqual(parsed.skills[0].provenance, { experienceSources: ['exp-b'], proposal: 'skill' })
  assert.match(parsed.skills[0].body, /触发：产出 pptx 时/)
  assert.match(parsed.skills[0].body, /1\) 生成 2\) 回读页数/)
  assert.equal(parsed.rejected, 3, 'sourceless and mis-sourced items are refused, not stored')
})

test('a run turns the journal into knowledge, proposals and an archive', async () => {
  const ids = await seedJournal(20)
  const calls = []
  const callModel = async (request) => {
    calls.push(request)
    return JSON.stringify({
      longTerm: [{
        type: 'user', title: '产出偏好', body: '交付前要自证', confidence: 0.9, sources: [ids[0], ids[1]],
      }],
      project: [{ title: 'PPT 校验', body: '生成后必须回读', confidence: 0.88, sources: [ids[2]] }],
      skills: [{
        name: 'pptx-readback',
        description: '生成 pptx 后回读校验',
        trigger: '产出 pptx 时',
        steps: ['生成文件', '回读页数'],
        confidence: 0.86,
        sources: [ids[3]],
      }],
    })
  }

  const report = await abstractExperienceJournal({ userId: USER, workspaceRoot: workspace, callModel })
  assert.equal(calls.length, 1, 'one model call for the whole journal')
  assert.equal(report.ok, true, report.error)
  assert.deepEqual(report.stored, { longTerm: 1, project: 1, skills: 1 })
  assert.equal(report.consumed, 20)

  const memories = listMemories({ userId: USER, limit: 50 })
  const knowledge = memories.find((memory) => memory.title === '产出偏好')
  assert.equal(knowledge.type, 'user')
  assert.equal(knowledge.frontmatter.source, 'experience_abstraction')
  assert.deepEqual(knowledge.frontmatter.experienceSources, [ids[0], ids[1]])
  assert.equal(memories.find((memory) => memory.title === 'PPT 校验').type, 'project')
  const proposal = memories.find((memory) => memory.title === 'pptx-readback')
  assert.equal(proposal.type, 'reference')
  assert.equal(proposal.frontmatter.proposal, 'skill')
  assert.match(proposal.body, /回读页数/)

  // The journal keeps only what has not been generalized yet, and the consumed
  // episodes stay readable in the archive beside it.
  const journal = readExperienceJournal({ userId: USER, workspaceRoot: workspace })
  assert.deepEqual(journal.entries, [])
  const archive = parseExperienceJournal(
    fs.readFileSync(path.join(path.dirname(experienceJournalPath(workspace)), 'experience.archive.md'), 'utf8'),
  )
  assert.equal(archive.entries.length, 20)
  assert.ok(archive.entries.every((entry) => entry.status === 'digested'))

  // Nothing left to generalize: another pass costs no model call.
  const again = await abstractExperienceJournal({ userId: USER, workspaceRoot: workspace, callModel })
  assert.equal(again.skipped, true)
  assert.equal(again.reason, 'empty')
  assert.equal(calls.length, 1)
})

test('an abstraction that reads nothing consumes nothing', async () => {
  await seedJournal(20)
  // The model returned no usable items (or none at all): the episodes must stay
  // pending, or the journal would lose lessons it never actually generalized.
  const report = await abstractExperienceJournal({
    userId: USER,
    workspaceRoot: workspace,
    callModel: async () => '{"longTerm":[],"project":[],"skills":[]}',
  })
  assert.equal(report.skipped, true)
  assert.equal(report.reason, 'nothing_generalized')
  assert.equal(listMemories({ userId: USER, limit: 50 }).length, 0)
  const journal = readExperienceJournal({ userId: USER, workspaceRoot: workspace })
  assert.equal(journal.entries.length, 20)
  assert.ok(journal.entries.every((entry) => entry.status === 'pending'))

  // A failing run reports instead of throwing, and leaves the journal alone.
  resetExperienceAbstractionCooldown()
  const failed = await abstractExperienceJournal({
    userId: USER,
    workspaceRoot: workspace,
    callModel: async () => { throw new Error('model down') },
  }).catch((error) => ({ threw: error.message }))
  assert.deepEqual(failed, { threw: 'model down' })
  assert.equal(readExperienceJournal({ userId: USER, workspaceRoot: workspace }).entries.length, 20)

  // And a second attempt inside the cooldown does not spend another call.
  resetExperienceAbstractionCooldown()
  await abstractExperienceJournal({
    userId: USER,
    workspaceRoot: workspace,
    callModel: async () => '{"longTerm":[]}',
  })
  const cooled = await abstractExperienceJournal({
    userId: USER,
    workspaceRoot: workspace,
    callModel: async () => '{"longTerm":[]}',
  })
  assert.equal(cooled.reason, 'cooldown')
})

for (const confidence of [0.6, 0.7, 0.78]) {
  test(`an experience abstraction at confidence ${confidence} follows the persistence threshold before archiving`, async () => {
    const ids = await seedJournal(20)
    let request
    const report = await abstractExperienceJournal({
      userId: USER,
      workspaceRoot: workspace,
      callModel: async (value) => {
        request = value
        return JSON.stringify({
          longTerm: [{
            type: 'user',
            title: `confidence-${confidence}`,
            body: `Durable preference at confidence ${confidence}.`,
            confidence,
            sources: [ids[0]],
          }],
          project: [],
          skills: [],
        })
      },
    })

    assert.equal(MIN_CONFIDENCE, 0.78)
    assert.match(request.messages[0].content, /confidence at least 0\.78/u)
    const archivePath = path.join(path.dirname(experienceJournalPath(workspace)), 'experience.archive.md')

    if (confidence < MIN_CONFIDENCE) {
      assert.equal(report.skipped, true)
      assert.equal(report.reason, 'nothing_stored')
      assert.equal(fs.existsSync(archivePath), false)
      assert.deepEqual(listMemories({ userId: USER, limit: 50 }), [])
      const journal = readExperienceJournal({ userId: USER, workspaceRoot: workspace })
      assert.equal(journal.entries.length, 20)
      assert.ok(journal.entries.every((entry) => entry.status === 'pending'))
    } else {
      assert.equal(report.skipped, false)
      assert.equal(report.stored.longTerm, 1)
      assert.equal(fs.existsSync(archivePath), true)
      assert.equal(readExperienceJournal({ userId: USER, workspaceRoot: workspace }).entries.length, 0)
      const archive = parseExperienceJournal(fs.readFileSync(archivePath, 'utf8'))
      assert.equal(archive.entries.length, 20)
      assert.equal(listMemories({ userId: USER, limit: 50 }).length, 1)
    }
  })
}
