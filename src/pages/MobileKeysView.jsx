/**
 * MobileKeysView — Hanako 平行：手机/局域网 access key 管理
 *
 * - 列出当前用户的 access keys（不含明文）
 * - 创建：label + 可选 TTL（小时数），show-once 显示 rawKey + QR 提示
 * - 撤销
 */
import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, MonitorSmartphone, Copy, Check, X } from 'lucide-react'
import AppLayout from '../components/AppLayout.jsx'
import Modal from '../components/Modal.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  listMobileKeysApi,
  createMobileKeyApi,
  revokeMobileKeyApi,
} from '../lib/mobileClient.js'

function fmtTs(ts, lang, emptyValue) {
  if (!ts) return emptyValue
  return new Date(ts).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
}

function fmtTtl(record, t) {
  if (!record.expiresAt) return t('mobile.permanent')
  const remain = record.expiresAt - Date.now()
  if (remain <= 0) return t('mobile.expired')
  const h = Math.floor(remain / 3600_000)
  const m = Math.floor((remain % 3600_000) / 60_000)
  return h > 0
    ? t('mobile.durationHoursMinutes', { hours: h, minutes: m })
    : t('mobile.durationMinutes', { minutes: m })
}

export default function MobileKeysView() {
  const { t, lang } = useT()
  const [keys, setKeys] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newTtlHours, setNewTtlHours] = useState('') // 空 = 永久
  const [revealed, setRevealed] = useState(null) // { rawKey, keyId, label }
  const [copied, setCopied] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const data = await listMobileKeysApi()
      setKeys(data.keys || [])
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
  }, [reload])

  const onCreate = async () => {
    setCreating(true)
    setErr('')
    try {
      const ttlMs = newTtlHours && Number(newTtlHours) > 0 ? Math.round(Number(newTtlHours) * 3600_000) : null
      const data = await createMobileKeyApi({ label: newLabel.trim(), ttlMs })
      setRevealed({ rawKey: data.rawKey, keyId: data.key.id, label: data.key.label })
      setShowCreate(false)
      setNewLabel('')
      setNewTtlHours('')
      await reload()
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setCreating(false)
    }
  }

  const onRevoke = async (id) => {
    if (!window.confirm(t('mobile.confirmRevoke'))) return
    try {
      await revokeMobileKeyApi(id)
      await reload()
    } catch (e) {
      setErr(e.message || String(e))
    }
  }

  const copyRaw = async () => {
    if (!revealed?.rawKey) return
    try {
      await navigator.clipboard.writeText(revealed.rawKey)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 不抛
    }
  }

  return (
    <AppLayout className="h-screen flex bg-paper overflow-hidden">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
          <MonitorSmartphone className="w-5 h-5 text-accent-ink" />
          <div className="flex-1">
            <div className="text-base font-semibold text-ink">{t('mobile.title')}</div>
            <div className="text-xs text-ink-fade">
              {t('mobile.subtitle')}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="h-8 px-3 bg-accent text-accent-contrast rounded-md text-xs hover:bg-accent/90 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('mobile.new')}
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {loading && <div className="text-sm text-ink-fade">{t('mobile.loading')}</div>}
          {err && <div className="text-sm text-danger mb-3">{err}</div>}

          {!loading && keys.length === 0 && (
            <div className="text-center text-sm text-ink-fade py-20">
              {t('mobile.empty')}
            </div>
          )}

          {keys.length > 0 && (
            <div className="max-w-3xl mx-auto flex flex-col gap-2">
              {keys.map((k) => (
                <div key={k.id} className="border border-ink/10 rounded-md p-3 bg-paper-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink truncate">
                      {k.label || t('mobile.noLabel')}
                    </div>
                    <div className="text-xs text-ink-fade mt-0.5 flex flex-wrap gap-x-3">
                      <span>{t('mobile.createdAt', { value: fmtTs(k.createdAt, lang, t('mobile.notAvailable')) })}</span>
                      <span>{t('mobile.lastUsedAt', { value: fmtTs(k.lastUsedAt, lang, t('mobile.neverUsed')) })}</span>
                      <span>{t('mobile.validFor', { value: fmtTtl(k, t) })}</span>
                      <span className="font-mono">{k.prefix}…</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRevoke(k.id)}
                    className="h-8 px-2 rounded-md border border-ink/10 hover:bg-danger/5 text-danger text-xs flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('mobile.revoke')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 创建对话框 */}
        {showCreate && (
          <Modal onClose={() => setShowCreate(false)} closeOnBackdrop={false} ariaLabelledby="mobile-key-create-title" className="w-[420px] max-w-[90vw] p-5 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div id="mobile-key-create-title" className="text-base font-semibold text-ink flex-1">
                  {t('mobile.createTitle')}
                </div>
                <button type="button" onClick={() => setShowCreate(false)} aria-label={t('mobile.close')} className="text-ink-fade hover:text-ink">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <label className="text-xs text-ink-soft">
                {t('mobile.label')}
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder={t('mobile.labelPlaceholder')}
                  className="w-full mt-1 border border-ink/10 rounded-md px-2 py-1.5 text-sm bg-paper-2 outline-none focus:border-focus/40"
                />
              </label>
              <label className="text-xs text-ink-soft">
                {t('mobile.ttlHours')}
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={newTtlHours}
                  onChange={(e) => setNewTtlHours(e.target.value)}
                  placeholder={t('mobile.ttlPlaceholder')}
                  className="w-full mt-1 border border-ink/10 rounded-md px-2 py-1.5 text-sm bg-paper-2 outline-none focus:border-focus/40"
                />
              </label>
              <div className="flex items-center gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="h-8 px-3 rounded-md border border-ink/10 text-xs text-ink-soft hover:bg-paper-2"
                >
                  {t('mobile.cancel')}
                </button>
                <button
                  type="button"
                  onClick={onCreate}
                  disabled={creating}
                  className="h-8 px-3 rounded-md bg-accent text-accent-contrast text-xs hover:bg-accent/90 disabled:opacity-60"
                >
                  {creating ? t('mobile.creating') : t('mobile.create')}
                </button>
              </div>
          </Modal>
        )}

        {/* show-once 显示明文 key */}
        {revealed && (
          <Modal onClose={() => setRevealed(null)} closeOnBackdrop={false} ariaLabelledby="mobile-key-reveal-title" className="w-[520px] max-w-[90vw] border-accent/40 p-5 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div id="mobile-key-reveal-title" className="text-base font-semibold text-ink flex-1">
                  {t('mobile.revealTitle')}
                </div>
                <button type="button" onClick={() => setRevealed(null)} aria-label={t('mobile.close')} className="text-ink-fade hover:text-ink">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="text-xs text-ink-fade">
                {t('mobile.revealHint')}
              </div>
              <div className="bg-paper-2 border border-ink/10 rounded-md p-3 font-mono text-sm break-all text-ink">
                {revealed.rawKey}
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  type="button"
                  onClick={copyRaw}
                  className="h-8 px-3 rounded-md border border-ink/10 text-xs text-ink-soft hover:bg-paper-2 flex items-center gap-1"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? t('mobile.copied') : t('mobile.copy')}
                </button>
                <button
                  type="button"
                  onClick={() => setRevealed(null)}
                  className="h-8 px-3 rounded-md bg-accent text-accent-contrast text-xs hover:bg-accent/90"
                >
                  {t('mobile.done')}
                </button>
              </div>
              <div className="text-xs text-ink-fade pt-1 border-t border-ink/5">
                {t('mobile.howToPrefix')} <span className="font-mono">/mobile.html</span> {t('mobile.howToSuffix')}
              </div>
          </Modal>
        )}
      </div>
    </AppLayout>
  )
}
