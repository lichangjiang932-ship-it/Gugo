function deepDomPrelude() {
  return `
    const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
    const collectRoots = () => {
      const roots = []; const frames = []; const seen = new Set(); let examined = 0; let truncated = false
      const visit = (root, trail) => {
        if (!root || seen.has(root) || roots.length >= 100) { if (root && !seen.has(root)) truncated = true; return }
        seen.add(root); roots.push({ root, trail })
        const elements = root.querySelectorAll ? root.querySelectorAll('*') : []
        for (const element of elements) {
          examined += 1
          if (examined > 10000) { truncated = true; break }
          if (element.shadowRoot) visit(element.shadowRoot, trail + ' > shadow(' + element.tagName.toLowerCase() + ')')
          if (element.tagName !== 'IFRAME') continue
          const src = element.src || element.getAttribute('src') || ''
          let childDocument = null
          try { childDocument = element.contentDocument } catch {}
          const accessible = !!childDocument
          frames.push({ src, accessible, trail: trail + ' > iframe' })
          if (accessible) visit(childDocument, trail + ' > iframe(' + (src || 'about:blank') + ')')
        }
      }
      visit(document, 'main')
      return { roots, frames, truncated }
    }
    const queryDeep = (target, roots) => {
      const escaped = globalThis.CSS?.escape
        ? globalThis.CSS.escape(target)
        : target.replace(/[^a-zA-Z0-9_-]/g, (character) => '\\\\' + character)
      for (const entry of roots) {
        let element = entry.root.querySelector?.('[data-yma-ref="' + escaped + '"]') || null
        if (!element) { try { element = entry.root.querySelector?.(target) || null } catch {} }
        if (element) return { element, trail: entry.trail }
      }
      return null
    }
  `
}

export function browserSnapshotExpression(limit) {
  return `(() => {
    ${deepDomPrelude()}
    const { roots, frames, truncated } = collectRoots()
    for (const entry of roots) {
      for (const old of entry.root.querySelectorAll?.('[data-yma-ref]') || []) old.removeAttribute('data-yma-ref')
    }
    const candidates = []
    for (const entry of roots) {
      const matches = entry.root.querySelectorAll?.('a,button,input,textarea,select,[role="button"],[contenteditable="true"]') || []
      for (const element of matches) candidates.push({ element, trail: entry.trail })
    }
    const nodes = candidates
      .filter(({ element }) => { const rectangle = element.getBoundingClientRect(); return rectangle.width > 0 && rectangle.height > 0 })
      .slice(0, 200)
      .map(({ element, trail }, index) => {
        const ref = 'e' + (index + 1); element.setAttribute('data-yma-ref', ref)
        const label = clean(element.innerText || element.value || element.textContent || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.name)
        return '[ref=' + ref + '] [' + trail + '] <' + element.tagName.toLowerCase() + '> ' + JSON.stringify(label).slice(0, 240)
      })
    const text = clean(roots.map(({ root }) => root.body?.innerText || root.textContent || '').join(' ')).slice(0, ${limit})
    return { url: location.href, title: document.title, text, elements: nodes, frames, traversalTruncated: truncated }
  })()`
}

export function elementExpression(refOrSelector, action) {
  const target = JSON.stringify(String(refOrSelector || ''))
  return `(() => {
    ${deepDomPrelude()}
    const target = ${target}; const match = queryDeep(target, collectRoots().roots); const el = match?.element
    if (!el) return { ok: false, error: 'element not found: ' + target }
    ${action}
  })()`
}

export function elementObjectExpression(refOrSelector) {
  const target = JSON.stringify(String(refOrSelector || ''))
  return `(() => {
    ${deepDomPrelude()}
    const target = ${target}; const match = queryDeep(target, collectRoots().roots); const el = match?.element
    if (!el) throw new Error('element not found: ' + target)
    if (!(el instanceof HTMLInputElement) || el.type !== 'file') throw new Error('target is not a file input')
    return el
  })()`
}
