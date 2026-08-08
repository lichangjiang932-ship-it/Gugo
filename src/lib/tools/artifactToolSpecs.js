export const ARTIFACT_TOOL_SPECS = {
  create_pptx: {
    type: 'function',
    function: {
      name: 'create_pptx',
      description: '\u751f\u6210\u53ef\u4e0b\u8f7d\u7684.PPTX \u6f14\u793a\u6587\u7a3f\u3002\u5fc5\u987b\u7528 --- \u5206\u9875\u3001# \u7ed3\u8bba\u5f0f\u6807\u9898\u3001\u7b2c\u4e8c\u884c <!-- type --> \u9875\u9762\u7c7b\u578b(cover/toc/section/data/chart/table/split/process/quote/content/end)\u3002\u56fe\u8868\u7528 ```chart``` \u5757\u3002\u5185\u5bb9\u9875\u6bcf\u6761\u8981\u70b9\u7528\u201c\u4e3b\u5f20\uff1b\u8bc1\u636e/\u673a\u5236/\u5f71\u54cd\uff1a\u5177\u4f53\u4e8b\u5b9e\u6216\u56e0\u679c\u94fe\u201d\uff0c\u7528\u6237\u8981\u6c42\u9875\u6570\u65f6\u4e25\u683c\u9075\u5b88\uff0c\u4e25\u7981\u8f93\u51fa\u5236\u4f5c\u5efa\u8bae\u6216\u8bf4\u660e\u5c3e\u5df4\u3002',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '\u6f14\u793a\u6587\u7a3f\u6807\u9898(\u4e5f\u4f5c\u4e3a\u4e0b\u8f7d\u6587\u4ef6\u540d)' },
          markdown: { type: 'string', description: '\u5e7b\u706f\u7247 markdown \u6e90,--- \u5206\u9875,\u9996\u884c # \u6807\u9898,\u6b21\u884c <!-- type -->' },
        },
        required: ['title', 'markdown'],
      },
    },
  },
  create_docx: {
    type: 'function',
    function: {
      name: 'create_docx',
      description: '\u751f\u6210\u53ef\u4e0b\u8f7d\u7684 Word \u6587\u6863(.docx).\u5f53\u7528\u6237\u9700\u8981\u957f\u6587\u62a5\u544a/\u5408\u540c/\u8bf4\u660e\u4e66\u65f6\u8c03\u7528\u3002markdown \u6807\u9898\u3001\u5217\u8868\u3001\u5f15\u7528\u3001\u4ee3\u7801\u5757\u90fd\u4f1a\u88ab\u6b63\u786e\u8f6c\u6362\u3002\u751f\u6210\u5b8c\u6210\u540e\u53f3\u4fa7\u81ea\u52a8\u9884\u89c8,\u7528\u6237\u53ef\u4e00\u952e\u4e0b\u8f7d\u3002',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '\u6587\u6863\u6807\u9898(\u4e5f\u4f5c\u4e3a\u4e0b\u8f7d\u6587\u4ef6\u540d)' },
          markdown: { type: 'string', description: '\u6587\u6863\u6b63\u6587 markdown' },
        },
        required: ['title', 'markdown'],
      },
    },
  },
  create_xlsx: {
    type: 'function',
    function: {
      name: 'create_xlsx',
      description: '\u751f\u6210\u53ef\u4e0b\u8f7d\u7684 Excel \u8868\u683c(.xlsx).\u5f53\u7528\u6237\u9700\u8981\u6570\u636e\u8868/\u5bf9\u6bd4\u8868/\u4efb\u52a1\u6e05\u5355\u65f6\u8c03\u7528\u3002\u4f18\u5148\u7528 rows(\u4e8c\u7ef4\u6570\u7ec4)\u7ed9\u7ed3\u6784\u5316\u6570\u636e,\u5426\u5219\u7528 markdown \u8868\u683c\u3002\u751f\u6210\u5b8c\u6210\u540e\u53f3\u4fa7\u81ea\u52a8\u9884\u89c8,\u7528\u6237\u53ef\u4e00\u952e\u4e0b\u8f7d\u3002',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '\u8868\u683c\u6807\u9898(\u4e5f\u4f5c\u4e3a\u4e0b\u8f7d\u6587\u4ef6\u540d)' },
          rows: {
            type: 'array',
            description: '\u4e8c\u7ef4\u6570\u7ec4\u5f62\u5f0f\u7684\u8868\u683c\u6570\u636e,\u7b2c\u4e00\u884c\u901a\u5e38\u662f\u8868\u5934.\u793a\u4f8b [["\u59d3\u540d","\u90e8\u95e8"],["\u5f20\u4e09","\u7814\u53d1"]]',
            items: { type: 'array', items: {} },
          },
          markdown: { type: 'string', description: '\u5f53\u4e0d\u4fbf\u7528 rows \u65f6,\u53ef\u4f20 markdown \u8868\u683c\u6216 csv \u6587\u672c(\u4e09\u53cd\u5f15\u53f7\u5305\u88f9)' },
        },
        required: ['title'],
      },
    },
  },
  create_react_component: {
    type: 'function',
    function: {
      name: 'create_react_component',
      description: '\u751f\u6210\u4e00\u4e2a\u53ef\u5728\u53f3\u4fa7\u5b9e\u65f6\u6e32\u67d3\u7684 React \u5355\u6587\u4ef6\u7ec4\u4ef6(\u7c7b\u4f3c Claude artifacts / Codex web preview)\u3002\u5f53\u7528\u6237\u8981\u6c42\u505a\u4ea4\u4e92\u5f0f demo\u3001\u53ef\u89c6\u5316\u3001\u5c0f\u5de5\u5177\u3001UI \u539f\u578b\u65f6\u8c03\u7528\u3002\u7ea6\u675f:\u5fc5\u987b\u662f\u5355\u6587\u4ef6,\u53ea\u80fd\u7528 React + ReactDOM(\u5df2\u6ce8\u5165\u5168\u5c40),\u4e0d\u80fd import \u4efb\u4f55\u5305,\u4e0d\u80fd\u8bbf\u95ee\u7f51\u7edc;\u53ef\u4ee5\u7528 useState/useEffect \u7b49\u6240\u6709 React hooks,\u53ef\u4ee5\u7528\u5185\u8054 Tailwind class(\u5df2\u6ce8\u5165 cdn)\u6216\u5185\u8054 style\u3002\u6e90\u7801\u672b\u5c3e\u5fc5\u987b export default \u4e00\u4e2a\u7ec4\u4ef6(\u5982 export default function App(){...})\u3002',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '\u7ec4\u4ef6\u6807\u9898(\u5c55\u793a\u5728\u9884\u89c8\u9876\u90e8 + \u6587\u4ef6\u540d)' },
          code: { type: 'string', description: '\u5b8c\u6574\u7684\u5355\u6587\u4ef6 React \u7ec4\u4ef6\u6e90\u7801,\u542b export default\u3002\u53ef\u4ee5\u7528 JSX \u548c\u73b0\u4ee3 ES \u8bed\u6cd5 \u2014 \u6c99\u7bb1\u7528 babel-standalone \u7f16\u8bd1\u3002' },
          description: { type: 'string', description: '\u53ef\u9009: \u7b80\u77ed\u8bf4\u660e\u8fd9\u4e2a\u7ec4\u4ef6\u505a\u4ec0\u4e48(\u5c55\u793a\u7ed9\u7528\u6237)' },
        },
        required: ['title', 'code'],
      },
    },
  },
  create_mermaid: {
    type: 'function',
    function: {
      name: 'create_mermaid',
      description: 'Create a Mermaid diagram artifact that opens in the right preview pane. Use for flows, architecture graphs, sequences, and system maps.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          diagram: { type: 'string', description: 'Mermaid source, for example flowchart TD; A-->B' },
          theme: { type: 'string', enum: ['default', 'neutral', 'dark', 'forest', 'base'] },
        },
        required: ['title', 'diagram'],
      },
    },
  },
  create_chart: {
    type: 'function',
    function: {
      name: 'create_chart',
      description: 'Create a Chart.js artifact from a JSON chart configuration. Use when data should be previewed visually instead of left as a table.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          config: { type: 'object', description: 'Chart.js config with type, data, and options.' },
        },
        required: ['title', 'config'],
      },
    },
  },
  create_svg: {
    type: 'function',
    function: {
      name: 'create_svg',
      description: 'Create a sanitized SVG artifact for logos, diagrams, icons, or vector illustrations.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          svg: { type: 'string', description: 'Complete inline SVG source, without scripts or external links.' },
        },
        required: ['title', 'svg'],
      },
    },
  },
  create_html_app: {
    type: 'function',
    function: {
      name: 'create_html_app',
      description: 'Create a self-contained HTML artifact. Prefer one complete document in html; files.index.html remains supported for compatibility.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          html: { type: 'string', description: 'Complete single-file HTML with inline CSS and JavaScript.' },
          files: {
            type: 'object',
            description: 'Map of filename to text content. Must include index.html. External script/link tags are rejected.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['title'],
      },
    },
  },
}

