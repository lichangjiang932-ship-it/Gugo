import { isHtmlDeckLike } from './artifactDetection.js'

const HTML_DECK_ENHANCER_CSS = `
html.yma-deck-active, html.yma-deck-active body {
  margin: 0 !important;
  width: 100% !important;
  height: 100% !important;
  overflow: hidden !important;
}
html.yma-deck-active .slide {
  width: 100vw !important;
  height: 100vh !important;
  min-height: 100vh !important;
  position: relative !important;
  overflow: hidden !important;
}
html.yma-deck-active .slide:not(.active) {
  display: none !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
.yma-deck-controls {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483647;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(255,255,255,.22);
  border-radius: 999px;
  color: #fff;
  background: rgba(10,10,14,.58);
  box-shadow: 0 16px 48px rgba(0,0,0,.28);
  backdrop-filter: blur(16px);
  font: 12px/1 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.yma-deck-controls button {
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 50%;
  color: inherit;
  background: rgba(255,255,255,.16);
  cursor: pointer;
}
.yma-deck-controls button:hover { background: rgba(255,255,255,.26); }
.yma-deck-controls .yma-deck-count { min-width: 54px; text-align: center; opacity: .86; }
`

const HTML_DECK_ENHANCER_SCRIPT = `
;(() => {
  if (window.__ymaDeck?.ready) return;
  const selector = '.slide,[data-slide],section,.page,.deck-page,.deck-slide,.presentation-slide';
  const raw = Array.from(document.querySelectorAll(selector));
  const slides = raw
    .filter((el, index, all) => el && el !== document.body && all.indexOf(el) === index)
    .filter((el, _, all) => !all.some((other) => other !== el && other.contains(el)));
  if (slides.length < 2) return;
  document.documentElement.classList.add('yma-deck-active');
  slides.forEach((slide, index) => {
    slide.classList.add('slide');
    slide.dataset.ymaSlide = String(index + 1);
    if (!slide.querySelector(':scope > .pager')) {
      const pager = document.createElement('div');
      pager.className = 'pager';
      pager.textContent = String(index + 1).padStart(2, '0') + ' / ' + String(slides.length).padStart(2, '0');
      slide.appendChild(pager);
    }
  });
  let current = Math.max(0, slides.findIndex((slide) => slide.classList.contains('active')));
  function render() {
    slides.forEach((slide, index) => {
      const active = index === current;
      slide.classList.toggle('active', active);
      slide.setAttribute('aria-hidden', active ? 'false' : 'true');
      if (active) {
        slide.style.display = '';
        slide.style.opacity = '';
        slide.style.pointerEvents = '';
      }
    });
    const count = document.querySelector('.yma-deck-count');
    if (count) count.textContent = String(current + 1).padStart(2, '0') + ' / ' + String(slides.length).padStart(2, '0');
  }
  function goTo(index) {
    const next = Math.max(0, Math.min(slides.length - 1, Number(index) || 0));
    current = next;
    render();
  }
  const api = {
    ready: true,
    count: slides.length,
    get current() { return current; },
    next: () => goTo(current + 1),
    prev: () => goTo(current - 1),
    goTo,
  };
  window.__ymaDeck = api;
  if (!document.querySelector('.yma-deck-controls')) {
    const controls = document.createElement('div');
    controls.className = 'yma-deck-controls';
    controls.innerHTML = '<button type="button" data-yma-prev aria-label="\u4e0a\u4e00\u9875">\u2039</button><span class="yma-deck-count"></span><button type="button" data-yma-next aria-label="\u4e0b\u4e00\u9875">\u203a</button>';
    controls.querySelector('[data-yma-prev]').addEventListener('click', api.prev);
    controls.querySelector('[data-yma-next]').addEventListener('click', api.next);
    document.body.appendChild(controls);
  }
  document.addEventListener('keydown', (event) => {
    const key = event.key;
    if (['ArrowRight', 'PageDown', ' '].includes(key)) { event.preventDefault(); api.next(); }
    else if (['ArrowLeft', 'PageUp'].includes(key)) { event.preventDefault(); api.prev(); }
    else if (key === 'Home') { event.preventDefault(); api.goTo(0); }
    else if (key === 'End') { event.preventDefault(); api.goTo(slides.length - 1); }
    else if (/^[1-9]$/.test(key)) { event.preventDefault(); api.goTo(Number(key) - 1); }
  });
  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'yma-deck-next') api.next();
    if (data.type === 'yma-deck-prev') api.prev();
    if (data.type === 'yma-deck-goto') api.goTo(data.index);
  });
  render();
})();`

function injectBeforeCloseTag(documentHtml, tag, injection) {
  const close = new RegExp(`</${tag}>`, 'i')
  if (close.test(documentHtml)) return documentHtml.replace(close, `${injection}</${tag}>`)
  return `${documentHtml}\n${injection}`
}

// Generated previews run in an opaque-origin iframe, so the parent page cannot
// repair near-white or heavily transparent text after it renders. This guard
// measures the effective text/background contrast inside the sandbox and only
// adjusts text that is effectively unreadable.
const HTML_PREVIEW_READABILITY_GUARD = `(function(){
  if (window.__ymaReadabilityGuard) return;
  window.__ymaReadabilityGuard = true;
  var MIN_CONTRAST = 2.65;
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|CANVAS|IMG|VIDEO|AUDIO)$/;
  function color(value) {
    var match = String(value || '').match(/rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:\\s*[,\\/]\\s*([\\d.]+))?\\s*\\)/i);
    return match ? { r:+match[1], g:+match[2], b:+match[3], a:match[4] == null ? 1 : +match[4] } : null;
  }
  function mix(top, bottom, alpha) {
    return { r:top.r*alpha+bottom.r*(1-alpha), g:top.g*alpha+bottom.g*(1-alpha), b:top.b*alpha+bottom.b*(1-alpha), a:1 };
  }
  function channel(value) {
    value /= 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }
  function luminance(value) {
    return 0.2126*channel(value.r) + 0.7152*channel(value.g) + 0.0722*channel(value.b);
  }
  function contrast(first, second) {
    var a = luminance(first), b = luminance(second);
    return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  }
  function backgroundFor(element) {
    var layers = [], node = element;
    while (node && node.nodeType === 1) {
      var parsed = color(getComputedStyle(node).backgroundColor);
      if (parsed && parsed.a > 0) layers.push(parsed);
      node = node.parentElement;
    }
    var result = { r:255, g:255, b:255, a:1 };
    for (var index=layers.length-1; index>=0; index-=1) result = mix(layers[index], result, layers[index].a);
    return result;
  }
  function hasDirectText(element) {
    for (var index=0; index<element.childNodes.length; index+=1) {
      var node = element.childNodes[index];
      if (node.nodeType === 3 && node.textContent.trim()) return true;
    }
    return false;
  }
  function effectiveOpacity(element) {
    var value = 1, culprit = null, node = element;
    while (node && node.nodeType === 1) {
      var current = parseFloat(getComputedStyle(node).opacity);
      if (Number.isFinite(current)) {
        value *= current;
        if (current < 0.58 && !culprit) culprit = node;
      }
      node = node.parentElement;
    }
    return { value:value, culprit:culprit };
  }
  function repair(element) {
    if (!element || SKIP.test(element.tagName) || !hasDirectText(element)) return;
    var style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    var foreground = color(style.color);
    if (!foreground) return;
    var background = backgroundFor(element);
    var opacity = effectiveOpacity(element);
    var alpha = Math.max(0, Math.min(1, foreground.a * opacity.value));
    if (contrast(mix(foreground, background, alpha), background) >= MIN_CONTRAST) return;
    var darkBackground = luminance(background) < 0.42;
    element.style.setProperty('color', darkBackground ? '#F3F4F6' : '#374151', 'important');
    element.style.setProperty('text-shadow', 'none', 'important');
    if (parseFloat(style.opacity) < 0.72) element.style.setProperty('opacity', '0.88', 'important');
    if (opacity.culprit && opacity.culprit !== document.body && opacity.culprit !== document.documentElement) {
      opacity.culprit.style.setProperty('opacity', '0.88', 'important');
    }
    element.setAttribute('data-yma-contrast-fixed', 'true');
  }
  function scan(root) {
    var scope = root && root.nodeType === 1 ? root : document.body;
    if (!scope) return;
    repair(scope);
    var elements = scope.querySelectorAll('*');
    for (var index=0; index<elements.length; index+=1) repair(elements[index]);
  }
  var queued = false;
  function schedule(root) {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function(){ queued=false; scan(root || document.body); });
  }
  function start() {
    schedule(document.body);
    setTimeout(function(){ schedule(document.body); }, 180);
    setTimeout(function(){ schedule(document.body); }, 700);
    setTimeout(function(){ schedule(document.body); }, 1600);
    if (window.MutationObserver && document.body) {
      new MutationObserver(function(records){
        for (var index=0; index<records.length; index+=1) {
          for (var child=0; child<records[index].addedNodes.length; child+=1) {
            var node = records[index].addedNodes[child];
            if (node.nodeType === 1) { schedule(node); return; }
          }
        }
      }).observe(document.body, { childList:true, subtree:true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
  else start();
})();`

export function enhanceHtmlPreviewReadability(documentHtml = '') {
  const doc = String(documentHtml || '')
  if (!doc || doc.includes('data-yma-readability-guard')) return doc
  return injectBeforeCloseTag(
    doc,
    'body',
    `<script data-yma-readability-guard="true">${HTML_PREVIEW_READABILITY_GUARD.replace(/<\/script>/gi, '<\\/script>')}</script>`,
  )
}

export function enhanceHtmlDeckDocument(documentHtml = '') {
  const doc = String(documentHtml || '')
  if (!isHtmlDeckLike(doc) || doc.includes('data-yma-deck-enhancer')) return doc
  const withCss = injectBeforeCloseTag(
    doc,
    'head',
    `<style data-yma-deck-enhancer="style">${HTML_DECK_ENHANCER_CSS}</style>`
  )
  return injectBeforeCloseTag(
    withCss,
    'body',
    `<script data-yma-deck-enhancer="script">${HTML_DECK_ENHANCER_SCRIPT.replace(/<\/script>/gi, '<\\/script>')}</script>`
  )
}

/**
 * \u628a HTML \u6e90\u5305\u88c5\u6210\u53ef\u653e\u8fdb iframe srcdoc \u7684\u5b8c\u6574\u6587\u6863 \u2014 \u7f3a doctype \u65f6\u8865\u5168\u3002
 */
