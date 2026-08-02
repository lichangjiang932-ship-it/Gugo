import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import EditablePlanCard from '../../src/components/EditablePlanCard.jsx'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Event = dom.window.Event
  globalThis.InputEvent = dom.window.InputEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  return dom
}

const labels = {
  'taskSteering.planTitle': '计划',
  'taskSteering.editPlanHint': '可编辑',
  'taskSteering.stepLabel': '计划步骤',
  'taskSteering.stepDescriptionLabel': '步骤说明',
  'taskSteering.stepDescriptionPlaceholder': '执行说明',
  'taskSteering.moveStepUp': '上移',
  'taskSteering.moveStepDown': '下移',
  'taskSteering.deleteStep': '删除',
  'taskSteering.addStep': '添加步骤',
  'taskSteering.newStepTitle': '新步骤',
  'taskSteering.approvePlan': '批准',
  'taskSteering.approvingPlan': '批准中',
}
const t = (key) => labels[key] || key

async function change(dom, act, element, value) {
  const prototype = element.tagName === 'TEXTAREA'
    ? dom.window.HTMLTextAreaElement.prototype
    : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
  await act(async () => {
    element.focus()
    setter.call(element, value)
    element.dispatchEvent(new dom.window.InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: 'insertText',
    }))
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

async function click(dom, act, element) {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

test('editable plan round-trips descriptions and adds descriptions to new steps', async () => {
  const dom = setupDom()
  const [{ act }, { createRoot }] = await Promise.all([
    import('react'),
    import('react-dom/client'),
  ])
  const approvals = []
  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(
        <EditablePlanCard
          plan={{
            objective: '完成修改',
            steps: [{
              id: 'job-1:execute',
              title: '修改代码',
              kind: 'execute',
              input: { action: 'edit', description: '原说明' },
            }],
          }}
          onApprove={(steps) => approvals.push(steps)}
          t={t}
        />,
      )
    })

    assert.equal(rootElement.querySelector('textarea').value, '原说明')
    await change(dom, act, rootElement.querySelector('textarea'), '更新说明')
    await click(dom, act, [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('添加步骤')))

    const textareas = rootElement.querySelectorAll('textarea')
    assert.equal(textareas.length, 2)
    await change(dom, act, textareas[1], '新步骤说明')
    await click(dom, act, [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('批准')))

    assert.equal(approvals.length, 1)
    assert.equal(approvals[0][0].id, 'job-1:execute')
    assert.equal(approvals[0][0].description, '更新说明')
    assert.equal(approvals[0][0].input.description, '更新说明')
    assert.equal(approvals[0][0].input.action, 'edit')
    assert.equal(approvals[0][1].description, '新步骤说明')
    assert.equal(approvals[0][1].input.description, '新步骤说明')
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
  }
})
