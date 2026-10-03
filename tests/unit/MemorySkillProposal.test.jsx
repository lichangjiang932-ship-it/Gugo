import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'

const COPY = {
  'memory.editTitle': 'Edit memory',
  'memory.newTitle': 'New memory',
  'memory.close': 'Close',
  'memory.type': 'Type',
  'memory.titleLabel': 'Title',
  'memory.bodyLabel': 'Body',
  'memory.linkHint': 'Links',
  'memory.pinned': 'Pinned',
  'memory.bindAgent': 'Agent',
  'memory.globalAgent': 'All agents',
  'memory.current': ' (current)',
  'memory.agentHint': 'Agent hint',
  'memory.save': 'Save',
  'memory.saving': 'Saving…',
  'memory.delete': 'Delete',
  'memory.selectHint': 'Select a memory',
  'memory.skillProposalBadge': 'Skill proposal',
  'memory.skillProposalHint': 'A skill proposed by the experience pipeline.',
  'memory.skillInstall': 'Install as a skill',
  'memory.skillInstalling': 'Installing…',
  'memory.skillInstalled': 'Installed as skill: {id}',
  'memory.skillInstallFailed': 'Could not install the skill: {reason}',
}

const t = (key, values) => Object.entries(values || {})
  .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), String(COPY[key] || key))

const TYPES = [{ id: 'reference', label: 'Reference', hint: '' }]

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return dom
}

const PROPOSAL = {
  id: 'memory-1',
  type: 'reference',
  title: 'pptx-readback',
  body: '生成后回读页数',
  frontmatter: { proposal: 'skill', experienceSources: ['exp-1'] },
}

async function renderEditor(editing, extra = {}) {
  const { createRoot } = await import('react-dom/client')
  const MemoryEditor = (await import('../../src/pages/memory/MemoryEditor.jsx')).default
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const installed = []
  await act(async () => {
    root.render(
      <MemoryEditor
        agents={[]}
        editing={editing}
        onChange={() => {}}
        onClose={() => {}}
        onDelete={() => {}}
        onInstallSkill={(memory) => { installed.push(memory) }}
        onSave={() => {}}
        t={t}
        types={TYPES}
        {...extra}
      />,
    )
  })
  return { container, installed }
}

test('a skill proposal offers to install itself, and says when it already has', async () => {
  setupDom()
  const first = await renderEditor(PROPOSAL)
  const install = first.container.querySelector('[data-testid="memory-skill-install"]')
  assert.ok(install, 'the proposal offers the action')
  assert.equal(install.textContent, 'Install as a skill')
  assert.match(first.container.textContent, /experience pipeline/)

  await act(async () => { install.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(first.installed, [PROPOSAL], 'the press carries the memory it belongs to')

  // Already installed: the same press would do nothing, so it is not offered.
  const installed = await renderEditor({
    ...PROPOSAL,
    frontmatter: { ...PROPOSAL.frontmatter, installedSkillId: 'pptx-readback' },
  })
  assert.equal(installed.container.querySelector('[data-testid="memory-skill-install"]'), null)
  assert.equal(
    installed.container.querySelector('[data-testid="memory-skill-installed"]').textContent,
    'Installed as skill: pptx-readback',
  )
})

test('a memory that is not a proposal never offers to become a skill', async () => {
  setupDom()
  const plain = await renderEditor({ ...PROPOSAL, frontmatter: { source: 'manual' } })
  assert.equal(plain.container.querySelector('[data-testid="memory-skill-proposal"]'), null)
  // Still rendered, but disabled: nothing that has not been saved can be installed.
  const unsaved = await renderEditor({ ...PROPOSAL, id: null })
  assert.equal(unsaved.container.querySelector('[data-testid="memory-skill-install"]')?.disabled, true)
})

test('installing in progress and failing both say so', async () => {
  setupDom()
  const running = await renderEditor(PROPOSAL, { skillInstalling: true })
  const button = running.container.querySelector('[data-testid="memory-skill-install"]')
  assert.equal(button.textContent, 'Installing…')
  assert.equal(button.disabled, true, 'no second press while the first is running')

  const failed = await renderEditor(PROPOSAL, { skillInstallError: '技能包被拒绝' })
  const alert = failed.container.querySelector('[data-testid="memory-skill-error"]')
  assert.equal(alert.getAttribute('role'), 'alert')
  assert.match(alert.textContent, /技能包被拒绝/)
})

test('the list marks proposals so they can be found without opening each one', async () => {
  setupDom()
  const { createRoot } = await import('react-dom/client')
  const MemoryList = (await import('../../src/pages/memory/MemoryList.jsx')).default
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <MemoryList
        agentNameById={new Map()}
        editingId=""
        error=""
        items={[PROPOSAL, { id: 'memory-2', type: 'user', title: '偏好', body: '喜欢先看结论', frontmatter: {} }]}
        loading={false}
        onEdit={() => {}}
        t={t}
      />,
    )
  })
  const rows = [...container.querySelectorAll('button')]
  assert.equal(rows.length, 2)
  assert.match(rows[0].textContent, /Skill proposal/)
  assert.doesNotMatch(rows[1].textContent, /Skill proposal/)
})
