const TOOL_IDS = Object.freeze([
  'fetch_url',
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'list_directory',
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'patch_file',
  'bash_exec',
  'run_command',
  'run_test',
  'docker_exec',
  'file_download',
  'git_status',
  'git_diff',
  'git_commit',
  'git_push',
  'git_rollback',
  'git_write',
  'run_project_check',
  'image_info',
  'image_transform',
  'media_probe',
  'media_transform',
  'pdf_info',
  'pdf_text',
  'pdf_transform',
  'archive_list',
  'archive_create',
  'archive_extract',
  'batch_rename',
  'file_hash_manifest',
])

export default function SettingsToolsPanel({ state, dispatch, t }) {
  const toolsConfig = state.toolsConfig || {}
  const onToggle = (id) => dispatch({ type: 'SET_TOOLS_CONFIG', payload: { [id]: !toolsConfig[id] } })
  return (
    <section className="flex flex-col gap-5 animate-float-up">
      <div>
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">TOOLS</span>
        <h1 className="font-semibold text-[28px] text-ink mt-1.5">{t('settingsTools.title')}</h1>
        <p className="text-sm text-ink-soft mt-1">{t('settingsTools.subtitle')}</p>
      </div>
      <div className="flex flex-col gap-2">
        {TOOL_IDS.map((id) => {
          const enabled = !!toolsConfig[id]
          const name = t(`settingsTools.tools.${id}.name`)
          return (
            <div key={id} className="p-3 border border-ink/20 rounded-md flex items-center gap-3 hover:border-ink/40 transition-colors">
              <div className="flex-1 min-w-0"><div className="text-sm text-ink">{name}</div><div className="font-mono text-[10px] tracking-wider text-ink-fade mt-0.5">{id}</div><div className="text-xs text-ink-soft mt-1">{t(`settingsTools.tools.${id}.desc`)}</div></div>
              <button type="button" data-tool-id={id} onClick={() => onToggle(id)} className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${enabled ? 'bg-ember' : 'bg-ink-fade/40'}`} aria-pressed={enabled} aria-label={`${name}: ${t(enabled ? 'settingsTools.enabled' : 'settingsTools.disabled')}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}
