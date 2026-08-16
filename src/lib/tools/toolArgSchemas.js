import { z } from 'zod'

const officeImagesSchema = z.array(z.object({
  path: z.string().min(1).max(2000),
  alt: z.string().max(500).optional(),
  target_index: z.number().int().min(1).optional(),
  anchor: z.string().regex(/^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/).optional(),
  x: z.number().min(0).optional(),
  y: z.number().min(0).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
}).strict()).max(50)

export const TOOL_ARG_SCHEMAS = {
  list_directory: z.object({
    path: z.string().min(1, 'path \u4e0d\u80fd\u4e3a\u7a7a').max(2000),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  web_search: z.object({
    query: z.string().min(1, 'query \u4e0d\u80fd\u4e3a\u7a7a').max(500, 'query \u8fc7\u957f'),
    max_results: z.number().int().min(1).max(10).optional(),
  }),
  fetch_url: z.object({
    url: z.string().url('url \u5fc5\u987b\u662f\u5408\u6cd5 http/https \u94fe\u63a5'),
  }),
  create_pptx: z.object({
    title: z.string().min(1, 'title \u4e0d\u80fd\u4e3a\u7a7a').max(200),
    // markdown:\u7528 --- \u5206\u9875\u6216 # \u5206\u9875;\u6bcf\u9875\u7b2c\u4e00\u884c\u975e\u5206\u9694\u5219\u5f53\u6807\u9898
    markdown: z.string().min(1, 'markdown \u4e0d\u80fd\u4e3a\u7a7a').max(60000),
    images: officeImagesSchema.optional(),
  }),
  create_docx: z.object({
    title: z.string().min(1, 'title \u4e0d\u80fd\u4e3a\u7a7a').max(200),
    markdown: z.string().min(1, 'markdown \u4e0d\u80fd\u4e3a\u7a7a').max(120000),
    images: officeImagesSchema.optional(),
  }),
  create_xlsx: z.object({
    title: z.string().min(1, 'title \u4e0d\u80fd\u4e3a\u7a7a').max(200),
    // \u4e8c\u7ef4\u6570\u7ec4 (\u4f18\u5148) \u6216 markdown \u8868\u683c / csv
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional(),
    markdown: z.string().max(60000).optional(),
    images: officeImagesSchema.optional(),
  }).refine((d) => Array.isArray(d.rows) ? d.rows.length > 0 : !!d.markdown,
    { message: '\u9700\u8981\u63d0\u4f9b rows \u6216 markdown \u81f3\u5c11\u4e00\u9879' }),
  create_react_component: z.object({
    title: z.string().min(1, 'title \u4e0d\u80fd\u4e3a\u7a7a').max(200),
    // \u5355\u6587\u4ef6 React \u7ec4\u4ef6\u6e90\u7801;\u6a21\u578b\u5fc5\u987b\u5bfc\u51fa\u4e00\u4e2a\u9ed8\u8ba4\u7ec4\u4ef6
    //   export default function App() { ... }
    // \u6c99\u7bb1\u91cc\u53ea\u80fd\u7528 react/react-dom \u2014 \u4e0d\u5141\u8bb8 import \u4efb\u4f55\u5305,\u4e5f\u4e0d\u5141\u8bb8\u7f51\u7edc.
    code: z.string().min(1, 'code \u4e0d\u80fd\u4e3a\u7a7a').max(40000),
    description: z.string().max(500).optional(),
  }),
  create_mermaid: z.object({
    title: z.string().min(1).max(200),
    diagram: z.string().min(1).max(50000),
    theme: z.enum(['default', 'neutral', 'dark', 'forest', 'base']).optional(),
  }),
  create_chart: z.object({
    title: z.string().min(1).max(200),
    config: z.record(z.string(), z.any()),
  }),
  create_svg: z.object({
    title: z.string().min(1).max(200),
    svg: z.string().min(1).max(200000),
  }),
  create_html_app: z.object({
    title: z.string().min(1).max(200),
    html: z.string().min(1).max(2000000).optional(),
    files: z.record(z.string(), z.string()).optional(),
    assets: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      path: z.string().min(1).optional(),
    }).strict()).max(500).optional(),
  }).refine((value) => !!value.html || !!value.files?.['index.html'], { message: 'html or files.index.html is required' }),
  Agent: z.object({
    subagent_type: z.enum(['explore', 'plan', 'general']).optional(),
    prompt: z.string().min(1).max(20000).optional(),
    description: z.string().min(1).max(120).optional(),
    tasks: z.array(z.object({
      subagent_type: z.enum(['explore', 'plan', 'general']),
      prompt: z.string().min(1).max(20000),
      description: z.string().min(1).max(120),
    })).min(1).max(3).optional(),
  }).superRefine((value, ctx) => {
    const hasSingle = value.subagent_type && value.prompt && value.description
    if (!hasSingle && !value.tasks?.length) {
      ctx.addIssue({ code: 'custom', message: 'provide one subagent task or a tasks array' })
    }
  }),
  // Feature 8: Todo \u2014 \u6574\u7ec4\u66ff\u6362 \u2014 \u6a21\u578b\u53ef\u53cd\u590d\u8c03\u7528\u66f4\u65b0\u72b6\u6001
  manage_todos: z.object({
    todos: z.array(z.object({
      content: z.string().min(1, 'content \u4e0d\u80fd\u4e3a\u7a7a').max(300),
      status: z.enum(['pending', 'in_progress', 'completed']),
      activeForm: z.string().min(1, 'activeForm \u4e0d\u80fd\u4e3a\u7a7a').max(300),
    })).max(50, 'todo \u6570\u91cf\u4e0a\u9650 50'),
  }).refine((d) => {
    const inProg = d.todos.filter((t) => t.status === 'in_progress').length
    return inProg <= 1
  }, { message: '\u540c\u4e00\u65f6\u95f4\u53ea\u5141\u8bb8\u4e00\u4e2a in_progress' }),

  // Reasonix-style multi_edit: \u539f\u5b50\u5316\u6279\u91cf SEARCH/REPLACE
  multi_edit: z.object({
    edits: z.array(z.object({
      path: z.string().min(1, 'path \u4e0d\u80fd\u4e3a\u7a7a').max(500),
      oldText: z.string().min(1, 'oldText \u4e0d\u80fd\u4e3a\u7a7a'),
      newText: z.string().min(0),
    })).min(1, '\u81f3\u5c11\u9700\u8981\u4e00\u4e2a edit').max(20, '\u5355\u6b21\u6700\u591a 20 \u4e2a edit'),
  }),

  // \u2605 M1: ripgrep \u4ee3\u7801\u641c\u7d22\u4e09\u4ef6\u5957
  grep_code: z.object({
    pattern: z.string().min(1, 'pattern \u4e0d\u80fd\u4e3a\u7a7a').max(1000),
    path: z.string().max(500).optional(),
    glob: z.string().max(200).optional(),
    file_type: z.string().regex(/^[a-z0-9+-]+$/i, 'file_type \u4ec5\u5141\u8bb8\u5b57\u6bcd\u6570\u5b57').optional(),
    case_sensitive: z.boolean().optional(),
    word: z.boolean().optional(),
    max_results: z.number().int().min(1).max(500).optional(),
  }),
  find_symbol: z.object({
    name: z.string().regex(/^[a-zA-Z_$][\w$]*$/, 'name \u5fc5\u987b\u662f\u5408\u6cd5\u6807\u8bc6\u7b26'),
    kind: z.enum(['all', 'function', 'class', 'const']).optional(),
    language: z.string().regex(/^[a-z0-9+-]+$/i).optional(),
    path: z.string().max(500).optional(),
    max_results: z.number().int().min(1).max(100).optional(),
  }),
  list_imports: z.object({
    file: z.string().min(1, 'file \u5fc5\u586b').max(500),
  }),
  apply_patch: z.object({
    patch: z.string().min(1, 'patch \u4e0d\u80fd\u4e3a\u7a7a').max(2 * 1024 * 1024, 'patch \u8fc7\u5927'),
    dry_run: z.boolean().optional(),
  }),
  reflect: z.object({
    observation: z.string().min(1, 'observation \u4e0d\u80fd\u4e3a\u7a7a').max(4000),
    what_worked: z.string().max(600).optional().nullable(),
    what_didnt: z.string().max(600).optional().nullable(),
    next_step: z.string().min(1, 'next_step \u4e0d\u80fd\u4e3a\u7a7a').max(600),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
  }),
  request_clarification: z.object({
    question: z.string().min(1, 'question \u4e0d\u80fd\u4e3a\u7a7a').max(4000),
    why: z.string().max(600).optional().nullable(),
    blocker_kind: z.enum(['missing_info', 'ambiguous_intent', 'permission', 'risk_decision', 'other']).optional(),
    options: z.array(z.string().max(200)).max(8).optional().nullable(),
  }),
}

