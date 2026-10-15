import { useMemo } from 'react'
import { compareModelWireDiagnostics } from '../../../../shared/modelWireDiagnostics.js'
import { promptCompilerDiagnosticsSchema } from '../../../../shared/promptCompilerDiagnostics.js'
import { requestTimingSummary } from '../../../lib/modelRequestTiming.js'

const comparison = (value, comparable = true) => !comparable || typeof value !== 'boolean' ? 'unknown' : value ? 'changed' : 'same'

/** Render public counters/status only. Never stringify request bodies, hashes, headers or reasoning. */
export default function RequestDiagnostics({ usage, t }) {
  const wire = usage.modelWireDiagnostics
  const app = usage.modelContextDiagnostics
  const timing = usage.modelTiming
  const crossTurn = useMemo(() => compareModelWireDiagnostics(usage.previousModelWireDiagnostics, wire), [usage.previousModelWireDiagnostics, wire])
  const parsedCompiler = promptCompilerDiagnosticsSchema.safeParse(usage.modelCompilerDiagnostics)
  const compiler = parsedCompiler.success ? parsedCompiler.data : null
  if (!wire && !app && !timing) return null
  const hasWire = wire?.version === 1 && wire.stage === 'wire' && wire.available === true
  const hasApp = app?.version === 1 && app.stage === 'pre_compaction'
  const nativeComparable = wire?.prefixComparable === true || typeof wire?.toolsChanged === 'boolean' || typeof wire?.bodyChanged === 'boolean'
  const compared = nativeComparable ? wire : crossTurn
  const crossReference = hasWire && !nativeComparable && crossTurn.prefixComparable
  const prefix = hasWire ? comparison(compared.prefixChanged, wire.identityComparable === true && compared.prefixComparable === true)
    : comparison(app?.stablePrefixChanged, hasApp && app.prefixComparable === true)
  const tools = hasWire ? comparison(compared.toolsChanged, wire.identityComparable === true) : comparison(app?.toolsChanged, hasApp)
  const toolsCount = hasWire && Number.isSafeInteger(wire.toolCount) && wire.toolCount >= 0 ? wire.toolCount : null
  const observed = requestTimingSummary(timing)
  const seconds = (ms) => ms === null ? t('usage.diagnosticUnknown') : `${(ms / 1000).toFixed(1)} s`
  const comparisonLabel = (value) => value === 'same' ? t('usage.comparisonSame')
    : value === 'changed' ? t('usage.comparisonChanged') : t('usage.comparisonUnknown')
  const row = (label, value) => <div className="flex justify-between gap-3"><dt>{t(label)}</dt><dd className="text-right font-mono text-ink">{value}</dd></div>
  return <details data-testid="request-diagnostics" data-prefix={prefix} data-tools={tools} className="mt-2 border-t border-ink/10 pt-2 text-xs leading-5">
    <summary className="cursor-pointer text-ink-soft">{t('usage.requestDiagnostics')}
      <span className="ml-2 text-ink-fade">{t(hasWire ? 'usage.wireObserved' : hasApp ? 'usage.applicationObserved' : 'usage.diagnosticUnknown')}</span>
    </summary>
    <dl className="mt-2 space-y-1">
      {row('usage.requestPrefix', comparisonLabel(prefix))}
      {row('usage.requestTools', comparisonLabel(tools))}
      {row('usage.actualToolCount', toolsCount === null ? t('usage.diagnosticUnknown') : toolsCount.toLocaleString())}
      {row('usage.compilerCache', !compiler ? t('usage.compilerUnmeasured') : compiler.source === 'turn_preparation'
        ? t('usage.compilerObserved', { hit: Object.values(compiler.blocks).filter(value => value === 'hit').length, miss: Object.values(compiler.blocks).filter(value => value === 'miss').length })
        : t(compiler.source === 'checkpoint_reuse' ? 'usage.compilerCheckpointReuse' : 'usage.compilerTurnReuse'))}
      {row('usage.firstProgress', seconds(observed.firstProgressMs))}
      {row('usage.firstPublic', seconds(observed.firstPublicMs))}
      {row('usage.releaseGap', seconds(observed.bufferedMs))}
      {row('usage.browserPaintOpportunity', seconds(usage.browserTiming?.paintOpportunityMs ?? null))}
    </dl>
    {crossReference && <p className="mt-2 text-ink-fade">{t('usage.previousTurnReference')}</p>}
    <p className="mt-2 text-ink-fade">{t('usage.diagnosticScope')}</p>
  </details>
}
