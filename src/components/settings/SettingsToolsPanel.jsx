const TOOLS = [
  { id: 'fetch_url', name: '抓取链接', desc: '让模型把页面正文抓回来转 markdown 阅读。' },
  { id: 'create_pptx', name: '生成 PPT 文件', desc: '直接生成可预览、可下载的 PPTX 卡片。' },
  { id: 'create_docx', name: '生成 Word 文件', desc: '直接产出 DOCX 文档或报告。' },
  { id: 'create_xlsx', name: '生成 Excel 文件', desc: '直接产出 XLSX 表格。' },
  { id: 'list_directory', name: '浏览本地目录', desc: '列出已授权工作区或本地文件夹的内容。' },
  { id: 'read_file', name: '读取本地文件', desc: '读取已授权路径内的 UTF-8 文件。' },
  { id: 'write_file', name: '写入本地文件', desc: '在已获读写授权的路径内创建或覆盖文件。' },
  { id: 'edit_file', name: '编辑本地文件', desc: '在已获读写授权的路径内精确替换文件内容。' },
  { id: 'bash_exec', name: '执行代码与命令', desc: '在已授权的读写目录中运行 Python、Node、PowerShell 和项目命令；写入型命令每次仍需确认。' },
  { id: 'git_status', name: 'Git 状态', desc: '只读查看工作区的 git status。' },
  { id: 'git_diff', name: 'Git 差异', desc: '只读查看 unified diff。' },
  { id: 'run_project_check', name: '项目检查', desc: '仅允许运行 lint、test 或 build。' },
]

export default function SettingsToolsPanel({ state, dispatch }) {
  const toolsConfig = state.toolsConfig || {}
  const onToggle = (id) => dispatch({ type: 'SET_TOOLS_CONFIG', payload: { [id]: !toolsConfig[id] } })
  return (
    <section className="flex flex-col gap-5 animate-float-up">
      <div>
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">TOOLS</span>
        <h1 className="font-hand text-[28px] text-ink mt-1.5">模型工具</h1>
        <p className="text-sm text-ink-soft mt-1">开启后会按工具调用协议把规格发送给模型，由模型自行决定何时调用。</p>
      </div>
      <div className="flex flex-col gap-2">
        {TOOLS.map((tool) => (
          <div key={tool.id} className="p-3 border border-ink/20 rounded-md flex items-center gap-3 hover:border-ink/40 transition-colors">
            <div className="flex-1 min-w-0"><div className="text-sm text-ink">{tool.name}</div><div className="font-mono text-[10px] tracking-wider text-ink-fade mt-0.5">{tool.id}</div><div className="text-xs text-ink-soft mt-1">{tool.desc}</div></div>
            <button onClick={() => onToggle(tool.id)} className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${toolsConfig[tool.id] ? 'bg-ember' : 'bg-ink-fade/40'}`} aria-pressed={!!toolsConfig[tool.id]} aria-label={`${tool.name}: ${toolsConfig[tool.id] ? '开启' : '关闭'}`}>
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper transition-all ${toolsConfig[tool.id] ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
