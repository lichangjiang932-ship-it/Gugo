import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

import ToolCallCard from '../../src/components/ToolCallCard.jsx'
import { I18nProvider } from '../../src/i18n/I18nProvider.jsx'

function renderToolCall(name, args) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ToolCallCard call={{ name, arguments: JSON.stringify(args), status: 'running' }} stepNumber={1} />
    </I18nProvider>,
  )
}

test('code-search tool summaries use the executor argument names', () => {
  assert.match(renderToolCall('grep_code', { pattern: 'executeToolCall' }), /executeToolCall/)
  assert.match(renderToolCall('find_symbol', { name: 'buildToolSpecs' }), /buildToolSpecs/)
})

test('planning and permission tools show human summaries instead of raw JSON', () => {
  const todoMarkup = renderToolCall('manage_todos', {
    todos: [{ status: 'in_progress', activeForm: '正在验证最终 PDF', content: '验证最终 PDF' }],
  })
  const todoHeader = todoMarkup.match(/<header[\s\S]*?<\/header>/u)?.[0] || ''
  assert.match(todoMarkup, /正在验证最终 PDF/)
  assert.doesNotMatch(todoHeader, /&quot;todos&quot;/)

  const directoryMarkup = renderToolCall('request_directory', {
    path: 'D:\\work\\report', access_mode: 'read_write', purpose: '保存最终文件',
  })
  assert.match(directoryMarkup, /Request directory/)
  assert.match(directoryMarkup, /D:\\work\\report/)

  const deliveryMarkup = renderToolCall('set_deliverables', { artifact_ids: ['pdf-1'] })
  const deliveryHeader = deliveryMarkup.match(/<header[\s\S]*?<\/header>/u)?.[0] || ''
  assert.match(deliveryMarkup, /1 final file/)
  assert.doesNotMatch(deliveryHeader, /artifact_ids/)
})

test('running tools expose a live elapsed clock', () => {
  assert.match(renderToolCall('bash_exec', { command: 'npm test' }), /data-testid="live-elapsed"/)
})

test('execution rows emphasize concrete paths and commands without a visible action label', () => {
  const readMarkup = renderToolCall('read_file', { path: 'D:\\work\\report.txt' })
  const commandMarkup = renderToolCall('run_command', { command: 'npm test' })
  assert.match(readMarkup, /D:\\work\\report\.txt/)
  assert.match(commandMarkup, /npm test/)
  assert.doesNotMatch(readMarkup, /chat-tool-label/)
  assert.doesNotMatch(commandMarkup, /chat-tool-label/)
  assert.match(readMarkup, /<span class="sr-only">Read file<\/span>/)
  assert.match(commandMarkup, /<span class="sr-only">Run command<\/span>/)
  assert.doesNotMatch(readMarkup, /title="Read file"/)
  assert.doesNotMatch(commandMarkup, /title="Run command"/)
})

test('only an exactly associated persisted file makes a path summary interactive', () => {
  const artifact = { id: 'script-1', toolCallId: 'call-1', filename: 'inspect_pdf.py', url: '/api/artifacts/script-1' }
  const otherArtifact = { id: 'report-1', toolCallId: 'call-1', filename: 'report.pdf', url: '/api/artifacts/report-1' }
  const handler = () => {}
  const render = (name, args, props = {}) => renderToStaticMarkup(
    <I18nProvider>
      <ToolCallCard
        call={{ id: 'call-1', name, arguments: JSON.stringify(args), status: 'success' }}
        stepNumber={1}
        {...props}
      />
    </I18nProvider>,
  )

  assert.match(
    render('write_file', { path: 'D:\\work\\inspect_pdf.py' }, { artifacts: [artifact], onOpenArtifact: handler }),
    /data-testid="tool-summary-open"/,
  )
  assert.doesNotMatch(
    render('write_file', { path: 'D:\\work\\inspect_pdf.py' }, { artifacts: [otherArtifact], onOpenArtifact: handler }),
    /data-testid="tool-summary-open"/,
  )
  assert.doesNotMatch(
    render('bash_exec', { command: 'python "D:\\work\\inspect_pdf.py"', expected_outputs: ['report.pdf'] }, { artifacts: [otherArtifact], onOpenArtifact: handler }),
    /data-testid="tool-summary-open"/,
  )
  assert.match(
    render('bash_exec', { command: 'python "D:\\work\\inspect_pdf.py"', expected_outputs: ['report.pdf'] }, { artifacts: [otherArtifact], onOpenArtifact: handler }),
    /data-testid="tool-artifact-open"[^>]*title="report\.pdf"/,
  )
  assert.doesNotMatch(
    render('read_file', { path: 'D:\\work\\inspect_pdf.py' }, { artifacts: [{ ...artifact, toolCallId: 'another-call' }], onOpenArtifact: handler }),
    /data-testid="tool-summary-open"/,
  )
  assert.match(
    render('read_file', { path: 'D:\\work\\inspect_pdf.py' }, { artifacts: [artifact], onOpenArtifact: handler }),
    /data-testid="tool-summary-open"/,
  )
  assert.doesNotMatch(
    render('write_file', { path: 'D:\\work\\inspect_pdf.py' }, { artifacts: [artifact, { ...artifact, id: 'script-duplicate' }], onOpenArtifact: handler }),
    /data-testid="tool-summary-open"/,
  )
})

test('clicking a managed file summary returns the exact artifact and call', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const artifact = { id: 'script-2', filename: 'inspect_pdf.py', url: '/api/artifacts/script-2' }
  const call = {
    id: 'write-2',
    name: 'write_file',
    arguments: JSON.stringify({ path: 'D:\\work\\inspect_pdf.py' }),
    status: 'success',
  }
  let opened = null
  let toggleCount = 0

  try {
    await act(async () => root.render(
      <I18nProvider>
        <ToolCallCard
          call={call}
          stepNumber={1}
          artifacts={[{ ...artifact, toolCallId: call.id }]}
          onOpenArtifact={(selectedArtifact, selectedCall) => {
            opened = { artifact: selectedArtifact, call: selectedCall }
          }}
          onToggle={() => { toggleCount += 1 }}
        />
      </I18nProvider>,
    ))

    const button = rootElement.querySelector('[data-testid="tool-summary-open"]')
    assert.ok(button)
    assert.equal(button.tagName, 'BUTTON')
    await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.equal(opened.artifact.id, artifact.id)
    assert.equal(opened.artifact.toolCallId, call.id)
    assert.equal(opened.call, call)
    assert.equal(toggleCount, 0)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('command artifacts open by their persisted filenames without turning the command into a file link', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/chat' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const call = {
    id: 'exec-1',
    name: 'run_command',
    arguments: JSON.stringify({ command: 'python inspect_pdf.py', expected_outputs: ['report.pdf', 'page.png'] }),
    status: 'success',
  }
  const artifacts = [
    { id: 'report-1', toolCallId: call.id, filename: 'report.pdf', url: '/api/artifacts/report-1' },
    { id: 'page-1', toolCallId: call.id, filename: 'page.png', url: '/api/artifacts/page-1' },
  ]
  const opened = []

  try {
    await act(async () => root.render(
      <I18nProvider>
        <ToolCallCard call={call} stepNumber={1} artifacts={artifacts} onOpenArtifact={(artifact) => opened.push(artifact.id)} />
      </I18nProvider>,
    ))
    assert.equal(rootElement.querySelector('[data-testid="tool-summary-open"]'), null)
    const buttons = [...rootElement.querySelectorAll('[data-testid="tool-artifact-open"]')]
    assert.deepEqual(buttons.map((button) => button.textContent.trim()), ['report.pdf', 'page.png'])
    await act(async () => buttons[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.deepEqual(opened, ['page-1'])
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('failed command keeps arguments and result in one expanded card whose copy control does not collapse it', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const rootElement = document.getElementById('root')
  const root = createRoot(rootElement)
  const copied = []
  let toggleCount = 0
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value) => copied.push(value) },
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })

  try {
    await act(async () => root.render(
      <I18nProvider>
        <ToolCallCard call={{
          name: 'bash_exec',
          arguments: JSON.stringify({ command: 'python broken.py' }),
          status: 'error',
          error: 'Command failed',
          result: JSON.stringify({
            ok: false,
            code: 'COMMAND_FAILED',
            exitCode: 2,
            stderr: 'SyntaxError: invalid syntax',
          }),
        }} stepNumber={2} expanded onToggle={() => { toggleCount += 1 }} />
      </I18nProvider>,
    ))

    const detailCard = rootElement.querySelector('[data-testid="tool-step-details"]')
    assert.ok(detailCard)
    assert.equal(rootElement.querySelectorAll('details').length, 0)
    assert.match(detailCard.textContent, /Arguments/)
    assert.match(detailCard.textContent, /Error/)
    assert.equal(rootElement.querySelector('.chat-tool-step-marker').textContent, '2')

    const resultDetails = detailCard.querySelector('[data-testid="tool-detail-result"] pre')?.textContent || ''
    assert.match(resultDetails, /COMMAND_FAILED/)
    assert.match(resultDetails, /"exitCode": 2/)
    assert.match(resultDetails, /SyntaxError: invalid syntax/)

    const copyButton = detailCard.querySelector('[data-testid="tool-detail-copy-result"]')
    assert.ok(copyButton)
    await act(async () => {
      copyButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    assert.equal(toggleCount, 0)
    assert.equal(copied.length, 1)
    assert.match(copied[0], /COMMAND_FAILED/)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})

test('running command keeps full output inside the controlled detail card', () => {
  const collapsedMarkup = renderToStaticMarkup(
    <I18nProvider>
      <ToolCallCard call={{
        name: 'bash_exec',
        arguments: JSON.stringify({ command: 'npm test' }),
        status: 'running',
        liveOutput: 'starting suite\nPASS activity stream\n42 tests passed',
      }} stepNumber={1} />
    </I18nProvider>,
  )
  assert.doesNotMatch(collapsedMarkup, /data-testid="tool-step-details"/)
  assert.doesNotMatch(collapsedMarkup, /42 tests passed/)

  const expandedMarkup = renderToStaticMarkup(
    <I18nProvider>
      <ToolCallCard call={{
        name: 'bash_exec',
        arguments: JSON.stringify({ command: 'npm test' }),
        status: 'running',
        liveOutput: 'starting suite\nPASS activity stream\n42 tests passed',
      }} stepNumber={1} expanded />
    </I18nProvider>,
  )
  assert.match(expandedMarkup, /data-testid="tool-step-details"/)
  assert.match(expandedMarkup, /data-testid="tool-live-output"/)
  assert.match(expandedMarkup, /42 tests passed/)
  assert.doesNotMatch(expandedMarkup, /<details/)
})
