import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RUNTIME_CAPABILITIES_MARKER,
  buildRuntimeCapabilityBlock,
  replaceRuntimeCapabilityBlock,
} from '../server/services/runtimeCapabilities.js'

const spec = (name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } })

test('capability block describes only tools exposed for the current turn', () => {
  const text = buildRuntimeCapabilityBlock({
    toolSpecs: [spec('read_file'), spec('media_transform'), spec('request_directory')],
    approvalMode: 'ask',
  })
  assert.match(text, /Files:/)
  assert.match(text, /Audio\/video:/)
  assert.match(text, /Authorization:/)
  assert.match(text, /call the tool now/i)
  assert.match(text, /Do not substitute copy-paste code, shell commands, or manual instructions/i)
  assert.match(text, /code, error, and hint/i)
  assert.match(text, /Do not repeat the identical failed call/i)
  assert.match(text, /verify changed or generated outputs/i)
  assert.doesNotMatch(text, /PDF:/)
  assert.doesNotMatch(text, /Images:/)
  assert.doesNotMatch(text, /Git:/)
})

test('capability block directs concrete file, shell, and PDF work through exposed tools', () => {
  const text = buildRuntimeCapabilityBlock({
    toolSpecs: [spec('write_file'), spec('bash_exec'), spec('pdf_transform')],
  })

  assert.match(text, /File changes:/)
  assert.match(text, /Code and automation:/)
  assert.match(text, /PDF:/)
  assert.match(text, /call the tool now/i)
})

test('bypass capability block forbids redundant directory authorization prompts', () => {
  const text = buildRuntimeCapabilityBlock({
    toolSpecs: [spec('read_file'), spec('write_file'), spec('request_directory')],
    approvalMode: 'bypass',
  })

  assert.match(text, /Approval mode: bypass \(allow all\)/)
  assert.match(text, /do not require an authorization prompt/i)
  assert.doesNotMatch(text, /- Authorization:/)
  assert.doesNotMatch(text, /Approval mode: unattended/)
})

test('plan capability block explains that restricted schemas are intentionally omitted', () => {
  const text = buildRuntimeCapabilityBlock({
    toolSpecs: [spec('read_file'), spec('write_file'), spec('bash_exec'), spec('run_project_check'), spec('web_search')],
    approvalMode: 'plan',
  })

  assert.match(text, /Plan mode intentionally supplies only local read-only tool schemas/i)
  assert.match(text, /file-mutation, command-execution, network, connector, browser-action, and other side-effect schemas are intentionally omitted/i)
  assert.match(text, /File changes: unavailable while plan mode is active/i)
  assert.match(text, /Web: unavailable while plan mode is active because network access is excluded/i)
  assert.match(text, /Restricted tool schemas are not exposed/i)
  assert.match(text, /switch to acceptEdits or normal/i)
  assert.doesNotMatch(text, /call the tool now/i)
})

test('normal and acceptEdits capability blocks describe their distinct approval behavior', () => {
  const tools = [spec('write_file'), spec('bash_exec')]
  assert.match(buildRuntimeCapabilityBlock({ toolSpecs: tools, approvalMode: 'normal' }), /File changes, commands, and external side effects require approval/i)
  assert.match(buildRuntimeCapabilityBlock({ toolSpecs: tools, approvalMode: 'acceptEdits' }), /local file edits proceed automatically; commands and external side effects still require approval/i)
})

test('capability block advertises PDF generation when create_pdf is exposed', () => {
  const text = buildRuntimeCapabilityBlock({ toolSpecs: [spec('create_pdf')] })
  assert.match(text, /Artifacts:/)
  assert.match(text, /exposed create_\*/)
})

test('capability block is replaced on resume instead of duplicated', () => {
  const old = { role: 'system', content: `${RUNTIME_CAPABILITIES_MARKER}\n- PDF: stale` }
  const next = replaceRuntimeCapabilityBlock([
    old,
    { role: 'user', content: 'continue' },
  ], { toolSpecs: [spec('image_info')] })
  assert.equal(next.filter((message) => String(message.content).includes(RUNTIME_CAPABILITIES_MARKER)).length, 1)
  assert.match(next[0].content, /Images:/)
  assert.doesNotMatch(next[0].content, /PDF:/)
  assert.equal(next.at(-1).role, 'user')
})

test('capability refresh preserves the terminal tool result used for retry recovery', () => {
  const next = replaceRuntimeCapabilityBlock([
    { role: 'system', content: 'base instructions' },
    { role: 'user', content: 'read the file' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'read-once' }] },
    { role: 'tool', tool_call_id: 'read-once', content: 'durable result' },
  ], { toolSpecs: [spec('read_file')] })

  assert.equal(next[0].content, 'base instructions')
  assert.match(next[1].content, /Files:/)
  assert.equal(next.at(-1).role, 'tool')
  assert.equal(next.at(-1).tool_call_id, 'read-once')
})
