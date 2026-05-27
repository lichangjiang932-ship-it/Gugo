import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
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
