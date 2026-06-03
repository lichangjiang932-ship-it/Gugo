import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import FullscreenMediaModal from './FullscreenMediaModal.jsx'

/**
 * MarkdownRenderer —— 安全渲染 Markdown + 代码高亮
 *
 * 流程：
 * 1. ReactMarkdown 把 markdown 解析为 hast
 * 2. rehype-sanitize 清洗危险 HTML（XSS 防护，schema 见 sanitizeSchema）
 * 3. rehype-highlight 给代码块加语法高亮 className
 *
 * 样式依赖 highlight.js 的主题 CSS，在 index.html 或全局 CSS 中引入即可。
 */

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), 'className'],
    pre: [...(defaultSchema.attributes?.pre || []), 'className'],
    span: [...(defaultSchema.attributes?.span || []), 'className'],
    a: [...(defaultSchema.attributes?.a || []), 'target', 'rel'],
  },
}

// 从 react-markdown 传进来的 children（字符串 / 元素 / 数组嵌套）里递归抽出纯文本，
// 供代码块「复制」按钮使用。highlight.js 会把代码拆成一堆 <span>，所以要递归。
function extractText(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && node.props) return extractText(node.props.children)
  return ''
}

// 代码块：在 <pre> 外层包一层 relative 容器，右上角常驻一键复制按钮。
// 常驻（非 hover-only）以保证触屏可达；hover/focus 时加深以示可点。
function CodeBlock({ children, ...props }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    const text = extractText(children)
    if (!navigator.clipboard?.writeText) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }).catch(() => {})
  }
  return (
    <div className="relative group/code my-2">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? '已复制' : '复制代码'}
        title={copied ? '已复制' : '复制代码'}
        className="absolute top-2 right-2 z-10 inline-flex items-center gap-1 h-6 px-2 rounded border border-ink-fade/40 bg-paper/90 text-[11px] text-ink-soft opacity-70 hover:opacity-100 hover:text-ink hover:border-ink-fade focus-visible:opacity-100 transition-opacity"
      >
        {copied ? <Check className="w-3 h-3 text-ember" /> : <Copy className="w-3 h-3" />}
        {copied ? '已复制' : '复制'}
      </button>
      <pre className="bg-paper-2 border border-ink-fade/30 rounded-md p-3 pr-14 overflow-x-auto text-sm" {...props}>
        {children}
      </pre>
    </div>
  )
}

export default function MarkdownRenderer({ children, className = '' }) {
  const [fullscreen, setFullscreen] = useState(null)

  return (
    <div className={`prose prose-sm max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeSanitize, sanitizeSchema],
          rehypeHighlight,
        ]}
        components={{
          // 自定义链接：强制新标签页打开 + noopener
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
              {children}
            </a>
          ),
          // 代码块容器（含右上角一键复制）
          pre: ({ children, ...props }) => (
            <CodeBlock {...props}>{children}</CodeBlock>
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
        {children || ''}
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
