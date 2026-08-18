import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw, ShieldAlert, Check, X, Pencil, Terminal, FilePen, FileText, Globe, MousePointerClick } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useT } from '../i18n/I18nProvider.jsx'
import { decideApproval, fetchApprovals, subscribeToApprovalEvents } from '../lib/approvalClient'

const RISK_TONE = {
  high: { dot: 'bg-red-500', text: 'text-red-600', border: 'border-red-500/40' },
  medium: { dot: 'bg-amber-500', text: 'text-amber-600', border: 'border-amber-500/40' },
  low: { dot: 'bg-ink-fade', text: 'text-ink-fade', border: 'border-ink-fade/40' },
}

const TOOL_ICON = {
  bash_exec: Terminal,
  write_file: FilePen,
  edit_file: FileText,
  apply_patch: FileText,
  fetch_url: Globe,
  browser_click: MousePointerClick,
  browser_type: MousePointerClick,
}

function formatTime(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ''
  }
}

export function ApprovalCard({ approval, onDecide, busy, t }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => JSON.stringify(approval.args ?? {}, null, 2))
  const [jsonError, setJsonError] = useState(null)

  const tone = RISK_TONE[approval.risk] || RISK_TONE.low
  const Icon = TOOL_ICON[approval.toolName] || ShieldAlert
  const metadataSource = approval.metadataSource === 'declared' ? 'declared' : 'fallback'

  const submitEdit = () => {
    let parsed
    try {
      parsed = JSON.parse(draft)
    } catch (err) {
      setJsonError(err.message)
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setJsonError(t('approvals.inbox.jsonMustBeObject'))
      return
    }
    setJsonError(null)
    onDecide(approval.id, 'edit', parsed)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`p-4 border rounded-md bg-paper ${tone.border}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <Icon className={`w-4 h-4 mt-1 shrink-0 ${tone.text}`} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-ink truncate">{approval.toolName}</span>
              <span className={`inline-flex items-center gap-1 font-mono text-[9px] tracking-wider uppercase ${tone.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />
                {t(`approvals.risk.${approval.risk}`)}
              </span>
              <span
                data-testid="approval-risk-source"
                className="font-mono text-[9px] text-ink-fade"
              >
                {t('approvals.source.label')}: {t(`approvals.source.${metadataSource}`)}
              </span>
            </div>
            {approval.reason && (
              <p className="font-semibold text-sm text-ink-soft mt-1">{approval.reason}</p>
            )}
            <p className="font-mono text-[10px] text-ink-fade mt-1">
              {t(`approvals.origin.${approval.origin}`)} · {formatTime(approval.createdAt)}
            </p>
          </div>
        </div>
      </div>

      {editing ? (
        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(14, Math.max(4, draft.split('\n').length))}
            spellCheck={false}
            className="w-full font-mono text-[11px] p-2.5 border border-ink/30 rounded bg-paper text-ink resize-y"
          />
          {jsonError && (
            <p className="font-semibold text-sm text-red-600 mt-1">{jsonError}</p>
          )}
        </div>
      ) : (
        <pre className="mt-3 p-2.5 border border-ink/20 rounded bg-paper/60 font-mono text-[11px] text-ink-soft overflow-x-auto max-h-48">
          {JSON.stringify(approval.args ?? {}, null, 2)}
        </pre>
      )}

      <div className="flex items-center gap-2 mt-3">
        {editing ? (
          <>
            <button
              onClick={submitEdit}
              disabled={busy}
              className="h-8 px-3 border border-emerald-500/60 rounded-md font-semibold text-sm text-emerald-700 hover:bg-emerald-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              {t('approvals.inbox.approveEdited')}
            </button>
            <button
              onClick={() => { setEditing(false); setJsonError(null); setDraft(JSON.stringify(approval.args ?? {}, null, 2)) }}
              disabled={busy}
              className="h-8 px-3 border border-dashed border-ink-fade/60 rounded-md font-semibold text-sm text-ink-soft hover:border-ink-fade transition-colors disabled:opacity-50"
            >
              {t('approvals.inbox.cancelEdit')}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => onDecide(approval.id, 'approve')}
              disabled={busy}
              className="h-8 px-3 border border-emerald-500/60 rounded-md font-semibold text-sm text-emerald-700 hover:bg-emerald-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              {t('approvals.inbox.approve')}
            </button>
            <button
              onClick={() => onDecide(approval.id, 'deny')}
              disabled={busy}
              className="h-8 px-3 border border-red-500/60 rounded-md font-semibold text-sm text-red-600 hover:bg-red-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" />
              {t('approvals.inbox.deny')}
            </button>
            <button
              onClick={() => setEditing(true)}
              disabled={busy}
              className="h-8 px-3 border border-dashed border-ink-fade/60 rounded-md font-semibold text-sm text-ink-soft hover:border-ink-fade transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <Pencil className="w-3.5 h-3.5" />
              {t('approvals.inbox.edit')}
            </button>
          </>
        )}
      </div>
    </motion.div>
  )
}

export default function ApprovalsInbox() {
  const { t } = useT()
  const [approvals, setApprovals] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await fetchApprovals({ status: 'pending' })
      setApprovals(list)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次加载 + 订阅 SSE。SSE 只当作「该刷新了」的信号,数据仍走 REST 拉取。
  useEffect(() => {
    let alive = true
    const refresh = () => { if (alive) load() }
    // 推迟到 microtask,避免在 effect 体里同步 setState 触发级联渲染
    Promise.resolve().then(refresh)
    let source
    try {
      source = { close: subscribeToApprovalEvents(refresh) }
    } catch {
      // SSE 不可用时退化为手动刷新,不阻断页面
    }
    return () => {
      alive = false
      try { source?.close() } catch { /* noop */ }
    }
  }, [load])

  const handleDecide = useCallback(async (id, decision, args) => {
    setBusyId(id)
    // 乐观移除
    const snapshot = approvals
    setApprovals((prev) => prev.filter((a) => a.id !== id))
    try {
      await decideApproval(id, decision, args)
      setError(null)
    } catch (err) {
      setApprovals(snapshot)
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }, [approvals])

  const counts = useMemo(() => ({
    total: approvals.length,
    high: approvals.filter((a) => a.risk === 'high').length,
  }), [approvals])

  return (
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />

      <div className="flex-1 p-8 overflow-y-auto">
        <div className="flex items-end justify-between mb-6">
          <div>
            <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">APPROVALS</span>
            <h1 className="font-semibold text-[28px] text-ink mt-1.5">{t('approvals.inbox.title')}</h1>
            <p className="font-semibold text-base text-ink-soft mt-1">{t('approvals.inbox.subtitle')}</p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md font-semibold text-sm text-ink-soft hover:border-ink-fade transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {t('approvals.inbox.refresh')}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3.5 mb-5 max-w-md">
          <div className="p-3.5 border border-ink/30 rounded-md bg-paper">
            <span className="font-mono text-[9px] tracking-wider text-ink-fade">{t('approvals.inbox.statPending')}</span>
            <div className="font-semibold text-[26px] text-ink mt-1.5">{counts.total}</div>
          </div>
          <div className="p-3.5 border border-ink/30 rounded-md bg-paper">
            <span className="font-mono text-[9px] tracking-wider text-red-600">{t('approvals.inbox.statHighRisk')}</span>
            <div className="font-semibold text-[26px] text-ink mt-1.5">{counts.high}</div>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-4 py-2.5 border border-dashed border-ember/60 rounded-md font-semibold text-sm text-ember">
            {error}
          </div>
        )}

        {approvals.length === 0 && !loading ? (
          <div className="py-16 text-center">
            <ShieldAlert className="w-8 h-8 text-ink-fade mx-auto mb-3" />
            <p className="font-semibold text-base text-ink-soft">{t('approvals.inbox.empty')}</p>
            <p className="font-semibold text-sm text-ink-fade mt-1">{t('approvals.inbox.emptyHint')}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 max-w-3xl">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onDecide={handleDecide}
                busy={busyId === approval.id}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
