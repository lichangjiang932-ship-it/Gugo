import { enhanceHtmlPreviewReadability } from '../../../lib/artifactPreview.js'

const REACT_SANDBOX_SCRIPT_SOURCES = [
  ['/sandbox/react.umd.js', 'react-library'],
  ['/sandbox/react-dom.umd.js', 'react-dom-library'],
  ['/sandbox/babel.standalone.js', 'babel-library'],
  ['/sandbox/tailwind.js', 'tailwind-library'],
]

function escapeHtml(value) {
  return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

export function normalizeReactSandboxNonce(value) {
  const nonce = String(value || '').trim()
  return nonce && /^[A-Za-z0-9+/_=-]+$/.test(nonce) ? nonce : ''
}

function nonceAttribute(nonce) {
  return nonce ? ` nonce="${nonce}"` : ''
}

export function buildReactSandboxCsp(value) {
  const nonce = normalizeReactSandboxNonce(value)
  const scriptPolicy = nonce
    ? `script-src 'nonce-${nonce}' 'strict-dynamic'`
    : "script-src 'self' 'unsafe-inline'"
  return `default-src 'self' data:; ${scriptPolicy}; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'`
}

export function buildReactSandboxDoc(code, labels = {}, options = {}) {
  const nonce = normalizeReactSandboxNonce(options?.nonce)
  const nonceAttr = nonceAttribute(nonce)
  const source = safeJson(String(code || ''))
  const safeLabels = safeJson({
    runtimeError: String(labels.runtimeError || ''),
    promiseError: String(labels.promiseError || ''),
    missingDefault: String(labels.missingDefault || ''),
    compileFailed: String(labels.compileFailed || ''),
    dependencyTimeout: String(labels.dependencyTimeout || ''),
  })
  const dependencies = REACT_SANDBOX_SCRIPT_SOURCES
    .map(([src, marker]) => `<script${nonceAttr} data-yma-react-sandbox="${marker}" src="${src}"></script>`)
    .join('')

  const boot = `(function(){
var labels=${safeLabels};
var source=${source};
var bootScript=document.currentScript;
var scriptNonce=bootScript&&bootScript.nonce||'';
function showErr(prefix,error){var box=document.getElementById('__err');box.textContent=String(prefix||'')+String(error&&error.stack||error&&error.message||error||'');box.style.display='block'}
window.addEventListener('error',function(event){showErr(labels.runtimeError,event.error||event.message||event)});
window.addEventListener('unhandledrejection',function(event){showErr(labels.promiseError,event.reason||event)});
function renderPreview(Component){if(!Component){showErr(labels.missingDefault,'');return}document.getElementById('__loading')?.remove();window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(Component))}
function execute(compiled){var runner=document.createElement('script');if(scriptNonce)runner.nonce=scriptNonce;runner.setAttribute('data-yma-react-sandbox','compiled-user-code');runner.textContent='try{var React=window.React,ReactDOM=window.ReactDOM;var useState=React.useState,useEffect=React.useEffect,useRef=React.useRef,useMemo=React.useMemo,useCallback=React.useCallback,useReducer=React.useReducer,useContext=React.useContext,useLayoutEffect=React.useLayoutEffect,Fragment=React.Fragment,createElement=React.createElement;window.__ymaReactPreviewDefault=undefined;'+compiled+'\\n;window.__ymaRenderReactPreview(window.__ymaReactPreviewDefault)}catch(error){window.__ymaReactPreviewError(error)}';document.body.appendChild(runner)}
function boot(){try{var rewritten=source.replace(/export\\s+default\\s+/m,'window.__ymaReactPreviewDefault = ');var compiled=window.Babel.transform(rewritten,{presets:['react',['env',{modules:false}]]}).code;window.__ymaRenderReactPreview=renderPreview;window.__ymaReactPreviewError=function(error){showErr(labels.runtimeError,error)};execute(compiled)}catch(error){showErr(labels.compileFailed,error)}}
if(window.Babel&&window.React&&window.ReactDOM)boot();else{var elapsed=0,timer=setInterval(function(){elapsed+=50;if(window.Babel&&window.React&&window.ReactDOM){clearInterval(timer);boot()}else if(elapsed>8000){clearInterval(timer);showErr(labels.dependencyTimeout,'')}},50)}
})();`

  const documentHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(labels.title)}</title>${dependencies}<style>html,body,#root{margin:0;padding:0;min-height:100vh;background:#fff;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#__err{position:fixed;top:0;left:0;right:0;background:#FEE2E2;color:#7F1D1D;padding:10px 14px;font-family:monospace;font-size:12px;z-index:99999;display:none;max-height:50vh;overflow:auto}#__loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#9CA3AF;font-size:13px}</style></head><body><div id="__err"></div><div id="root"><div id="__loading">${escapeHtml(labels.loading)}</div></div><script${nonceAttr} data-yma-react-sandbox="boot">${boot.replace(/<\/script>/gi, '<\\/script>')}</script></body></html>`
  return enhanceHtmlPreviewReadability(documentHtml, { nonce })
}
