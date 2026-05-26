import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import DOMPurify from 'dompurify'
import FullscreenMediaModal from './FullscreenMediaModal.jsx'
import { extractArtifacts, isSafeArtifactPath } from '../lib/artifactMarker.js'

const ARTIFACT_SCHEME = 'artifact:'

// 把 markdown 里裸 [file.pptx] 改写为 [file.pptx](artifact:file.pptx),
// link 形式已合法 — 只需改写 target 加 scheme. 保证 idempotent.
function rewriteArtifactMarkers(md) {
  if (typeof md !== 'string' || !md) return md
  const arts = extractArtifacts(md)
  if (!arts.length) return md
  let out = ''
  let cursor = 0
  for (const a of arts) {
    out += md.slice(cursor, a.start)
    if (a.source === 'bare') {
      out += `[${a.label}](${ARTIFACT_SCHEME}${a.file})`
    } else {
      // link 形式, target 已 safe, 添上 scheme 以便 a-handler 拦截
      out += `[${a.label}](${ARTIFACT_SCHEME}${a.file})`
    }
    cursor = a.end
  }
  out += md.slice(cursor)
  return out
}

function openArtifact(file) {
  if (!isSafeArtifactPath(file)) return
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('artifact:open', { detail: { file, type: file.split('.').pop().toLowerCase() } })
  )
}

/**
 * MarkdownRenderer —— 安全渲染 Markdown + 代码高亮
 *
 * 流程：
 * 1. DOMPurify 过滤危险 HTML（防 XSS）
 * 2. react-markdown 解析 Markdown
 * 3. rehype-highlight 语法高亮代码块
 *
 * 样式依赖 highlight.js 的主题 CSS，在 index.html 或全局 CSS 中引入即可。
 */

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'img', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub',
]

const ALLOWED_ATTR = ['href', 'title', 'alt', 'src', 'class', 'id']

function sanitizeHtml(raw) {
  if (typeof raw !== 'string') return ''
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    KEEP_CONTENT: true,
  })
}

export default function MarkdownRenderer({ children, className = '' }) {
  const rewritten = useMemo(() => rewriteArtifactMarkers(children || ''), [children])
  const safeContent = sanitizeHtml(rewritten)
  const [fullscreen, setFullscreen] = useState(null)

  return (
    <div className={`prose prose-sm max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={(url) => {
          // 保留 artifact: scheme, 其他走默认 sanitizer
          if (typeof url === 'string' && url.startsWith(ARTIFACT_SCHEME)) return url
          return undefined // react-markdown 会 fallback 默认
        }}
        components={{
          // 自定义链接：识别 artifact: scheme 转可点击触发器
          a: ({ href, children, ...props }) => {
            if (typeof href === 'string' && href.startsWith(ARTIFACT_SCHEME)) {
              const file = href.slice(ARTIFACT_SCHEME.length)
              return (
                <button
                  type="button"
                  data-artifact-trigger={file}
                  onClick={(e) => { e.preventDefault(); openArtifact(file) }}
                  className="inline-flex items-center gap-1 align-baseline"
                  style={{
                    color: 'var(--p0-accent, #D97757)',
                    borderBottom: '1px dashed var(--p0-accent, #D97757)',
                    background: 'transparent',
                    padding: 0,
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                  title={`打开 ${file}`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                  {children}
                </button>
              )
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            )
          },
          // 代码块容器
          pre: ({ children, ...props }) => (
            <pre className="bg-paper-2 border border-ink-fade/30 rounded-md p-3 overflow-x-auto my-2 text-sm" {...props}>
              {children}
            </pre>
          ),
          // 内联代码
          code: ({ inline, className, children, ...props }) => {
            if (inline) {
              return (
                <code className="bg-paper-2 px-1 py-0.5 rounded text-xs font-mono text-ember" {...props}>
                  {children}
                </code>
              )
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
          // 图片：点击进入全屏查看器
          img: ({ src, alt, ...props }) => (
            <img
              {...props}
              src={src}
              alt={alt || ''}
              className="cursor-zoom-in rounded border border-ink-fade/30 max-w-full h-auto"
              onClick={() => src && setFullscreen({ src, alt: alt || '' })}
            />
          ),
          // 引用块
          blockquote: ({ children, ...props }) => (
            <blockquote className="border-l-2 border-ember pl-3 py-1 my-2 text-ink-soft italic" {...props}>
              {children}
            </blockquote>
          ),
          // 表格
          table: ({ children, ...props }) => (
            <table className="w-full text-sm border-collapse my-2" {...props}>
              {children}
            </table>
          ),
          th: ({ children, ...props }) => (
            <th className="border border-ink-fade/30 px-2 py-1 bg-paper-2 text-left font-semibold" {...props}>
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td className="border border-ink-fade/30 px-2 py-1" {...props}>
              {children}
            </td>
          ),
        }}
      >
        {safeContent}
      </ReactMarkdown>
      {fullscreen && (
        <FullscreenMediaModal
          src={fullscreen.src}
          alt={fullscreen.alt}
          onClose={() => setFullscreen(null)}
        />
      )}
    </div>
  )
}
