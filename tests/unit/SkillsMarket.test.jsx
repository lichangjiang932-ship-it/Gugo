import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { LOCAL_SKILLS_KEY } from '../../src/lib/localSkills.js'

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/skills',
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.HTMLInputElement = dom.window.HTMLInputElement
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  globalThis.SVGElement = dom.window.SVGElement
  globalThis.Event = dom.window.Event
  globalThis.InputEvent = dom.window.InputEvent
  globalThis.KeyboardEvent = dom.window.KeyboardEvent
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.localStorage = dom.window.localStorage
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })
  return dom
}

async function click(dom, act, element) {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    }))
    await Promise.resolve()
  })
}

async function enterValue(dom, act, element, value) {
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

test('自定义技能创建后持久化可执行指令并立即出现在技能库', async () => {
  const dom = setupDom()
  const [
    { act },
    { createRoot },
    { HashRouter },
    { default: SkillsMarket },
    { ToastProvider },
    { I18nProvider },
    { AppProvider },
  ] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../../src/lib/router.jsx'),
    import('../../src/pages/SkillsMarket.jsx'),
    import('../../src/components/Toast.jsx'),
    import('../../src/i18n/I18nProvider.jsx'),
    import('../../src/store/AppContext.jsx'),
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    skills: [{
      id: 'needs-runtime-skill',
      name: 'Needs Runtime Skill',
      desc: 'Requires a resource resolver',
      perms: [],
      runnable: false,
      compatibility: 'needs-runtime',
    }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

  const rootElement = dom.window.document.getElementById('root')
  const root = createRoot(rootElement)
  try {
    await act(async () => {
      root.render(
        <HashRouter>
          <I18nProvider>
            <ToastProvider>
              <AppProvider>
                <SkillsMarket />
              </AppProvider>
            </ToastProvider>
          </I18nProvider>
        </HashRouter>,
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const blockedSkill = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Needs Runtime Skill'))
    assert.ok(blockedSkill)
    assert.match(blockedSkill.textContent, /needs-runtime/)
    await click(dom, act, blockedSkill)

    const detailDialog = rootElement.querySelector('[role="dialog"]')
    assert.ok(detailDialog)
    assert.match(detailDialog.textContent, /needs-runtime/)
    assert.ok(detailDialog.querySelector('button:disabled'))
    await click(dom, act, detailDialog.parentElement)

    const customButton = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '自定义')
    assert.ok(customButton)
    await click(dom, act, customButton)

    const idInput = rootElement.querySelector('input[placeholder="my-skill"]')
    const nameInput = rootElement.querySelector('input[placeholder="我的技能"]')
    const promptInput = rootElement.querySelector('textarea[placeholder^="说明模型应如何工作"]')
    assert.ok(idInput && nameInput && promptInput)

    await enterValue(dom, act, idInput, 'quality-guard')
    await enterValue(dom, act, nameInput, '质量守卫')
    await enterValue(dom, act, promptInput, '先检查事实与风险，再输出可执行结论。')

    const createButton = [...rootElement.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '创建')
    assert.ok(createButton)
    assert.equal(createButton.disabled, false)
    await click(dom, act, createButton)

    const saved = JSON.parse(dom.window.localStorage.getItem(LOCAL_SKILLS_KEY))
    assert.equal(saved[0].id, 'quality-guard')
    assert.equal(saved[0].name, '质量守卫')
    assert.equal(saved[0].systemPrompt, '先检查事实与风险，再输出可执行结论。')
    assert.match(rootElement.textContent, /质量守卫/)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    dom.window.close()
  }
})
