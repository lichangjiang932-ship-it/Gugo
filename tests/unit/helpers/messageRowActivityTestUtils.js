import { JSDOM } from 'jsdom'

export function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/chat',
  })
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    MouseEvent: dom.window.MouseEvent,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previousGlobals = new Map(Object.keys(globals).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]))

  Object.assign(globalThis, globals)

  const closeWindow = dom.window.close.bind(dom.window)
  let closed = false
  dom.window.close = () => {
    if (closed) return
    closed = true
    closeWindow()
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
  return dom
}
