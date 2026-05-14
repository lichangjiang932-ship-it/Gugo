import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import DOMPurify from 'dompurify'

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
  const safeContent = sanitizeHtml(children || '')

  return (
    <div className={`prose prose-sm max-w-none ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // 自定义链接：强制新标签页打开 + noopener
          a: ({ href, children, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
              {children}
            </a>
          ),
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
    </div>
  )
}
