import { Terminal } from 'lucide-react'
import { SectionTitle } from './PermissionSectionPrimitives.jsx'

export function CodeExecutionStatusSection({ controller, t }) {
  const statusLoaded = controller.localFiles != null
  const shellRuntimeEnabled = controller.localFiles?.runtime?.localCodeExecutionEnabled
  const runCodeRuntimeEnabled = controller.localFiles?.runtime?.runCodeExecutionEnabled
  const shellRuntimeKnown = typeof shellRuntimeEnabled === 'boolean'
  const runCodeRuntimeKnown = typeof runCodeRuntimeEnabled === 'boolean'
  const shellToolEnabled = controller.isToolEnabled('bash_exec')
  const runCodeToolEnabled = controller.isToolEnabled('run_code')
  const writableDirectories = (controller.localFiles?.grants || []).filter((grant) => (
    grant.resourceType === 'directory'
    && grant.accessMode === 'read_write'
    && grant.available !== false
  ))
  const shellReady = shellRuntimeEnabled === true && shellToolEnabled && writableDirectories.length > 0
  const runCodeReady = runCodeRuntimeEnabled === true && runCodeToolEnabled
  const shellStatusKey = !statusLoaded
    ? 'codeExecutionChecking'
    : !shellRuntimeKnown
      ? 'codeExecutionRuntimeUnknown'
      : shellRuntimeEnabled !== true
        ? 'codeExecutionRuntimeBlocked'
        : !shellToolEnabled
          ? 'codeExecutionToolBlocked'
          : writableDirectories.length === 0
            ? 'codeExecutionNeedsWritableDirectory'
            : 'codeExecutionReady'
  const runCodeStatusKey = !statusLoaded
    ? 'codeExecutionRunCodeChecking'
    : !runCodeRuntimeKnown
      ? 'codeExecutionRunCodeRuntimeUnknown'
      : runCodeRuntimeEnabled !== true
        ? 'codeExecutionRunCodeRuntimeBlocked'
        : !runCodeToolEnabled
          ? 'codeExecutionRunCodeToolBlocked'
          : 'codeExecutionRunCodeReady'
  const rows = [
    {
      id: 'shell-runtime',
      label: t('localFiles.codeExecutionShellRuntime'),
      value: !statusLoaded
        ? t('localFiles.codeExecutionLoading')
        : !shellRuntimeKnown
          ? t('localFiles.codeExecutionUnknown')
          : t(shellRuntimeEnabled ? 'localFiles.codeExecutionEnabled' : 'localFiles.codeExecutionDisabled'),
      enabled: shellRuntimeEnabled === true,
    },
    {
      id: 'shell-tool',
      label: t('localFiles.codeExecutionShellToolGate'),
      value: t(shellToolEnabled ? 'localFiles.codeExecutionEnabled' : 'localFiles.codeExecutionDisabled'),
      enabled: shellToolEnabled,
    },
    {
      id: 'directories',
      label: t('localFiles.codeExecutionWritableDirectories'),
      value: String(writableDirectories.length),
      enabled: writableDirectories.length > 0,
    },
    {
      id: 'run-code-runtime',
      label: t('localFiles.codeExecutionRunCodeRuntime'),
      value: !statusLoaded
        ? t('localFiles.codeExecutionLoading')
        : !runCodeRuntimeKnown
          ? t('localFiles.codeExecutionUnknown')
          : t(runCodeRuntimeEnabled ? 'localFiles.codeExecutionEnabled' : 'localFiles.codeExecutionDisabled'),
      enabled: runCodeRuntimeEnabled === true,
    },
    {
      id: 'run-code-tool',
      label: t('localFiles.codeExecutionRunCodeToolGate'),
      value: t(runCodeToolEnabled ? 'localFiles.codeExecutionEnabled' : 'localFiles.codeExecutionDisabled'),
      enabled: runCodeToolEnabled,
    },
  ]
  const summaries = [
    {
      id: 'shell',
      tool: 'bash_exec',
      ready: shellReady,
      text: t(`localFiles.${shellStatusKey}`, { count: writableDirectories.length }),
    },
    {
      id: 'run-code',
      tool: 'run_code',
      ready: runCodeReady,
      text: t(`localFiles.${runCodeStatusKey}`),
    },
  ]

  return (
    <>
      <SectionTitle eyebrow="CODE EXECUTION" title={t('localFiles.codeExecutionTitle')} />
      <p className="mb-2 text-xs text-ink-fade">{t('localFiles.codeExecutionHint')}</p>
      <div className="mb-6 overflow-hidden rounded-md border border-ink/30" data-testid="code-execution-status">
        <div className="grid gap-3 border-b border-dashed border-ink-fade/40 px-4 py-3 sm:grid-cols-2 lg:grid-cols-5">
          {rows.map((row) => (
            <div key={row.id} className="rounded-md border border-ink-fade/40 bg-paper-2 px-3 py-2">
              <div className="font-mono text-[9px] uppercase tracking-wider text-ink-fade">{row.label}</div>
              <div className={`mt-1 flex items-center gap-1.5 text-sm ${row.enabled ? 'text-success' : 'text-ink-soft'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${row.enabled ? 'bg-success' : 'bg-ink-fade'}`} />
                {row.value}
              </div>
            </div>
          ))}
        </div>
        <div className="grid sm:grid-cols-2">
          {summaries.map((summary, index) => (
            <div
              key={summary.id}
              data-testid={`code-execution-${summary.id}-status`}
              className={`flex items-start gap-3 px-4 py-3 ${index === 0 ? 'border-b border-dashed border-ink-fade/40 sm:border-b-0 sm:border-r' : ''} ${summary.ready ? 'text-success' : 'text-ink-soft'}`}
            >
              <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${summary.ready ? 'border-success/40 bg-success/5' : 'border-ink-fade/50 bg-paper-2'}`}>
                <Terminal className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm">{summary.text}</div>
                <div className="mt-1 font-mono text-[10px] text-ink-fade">{summary.tool}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
