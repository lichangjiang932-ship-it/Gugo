/**
 * MobileKeysView — Hanako 平行：手机/局域网 access key 管理
 *
 * - 列出当前用户的 access keys（不含明文）
 * - 创建：label + 可选 TTL（小时数），show-once 显示 rawKey + QR 提示
 * - 撤销
 */
import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, MonitorSmartphone, Copy, Check, X } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  listMobileKeysApi,
  createMobileKeyApi,
  revokeMobileKeyApi,
} from '../lib/mobileClient.js'

function fmtTs(ts) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function fmtTtl(record) {
  if (!record.expiresAt) return '永久'
  const remain = record.expiresAt - Date.now()
  if (remain <= 0) return '已过期'
  const h = Math.floor(remain / 3600_000)
  const m = Math.floor((remain % 3600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function MobileKeysView() {
  const t = useT()
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
    const t = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(t)
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
    if (!window.confirm(t('mobile.confirmRevoke') || '撤销该 access key?')) return
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
    <div className="h-screen flex bg-paper overflow-hidden">
      <LeftRail />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
          <MonitorSmartphone className="w-5 h-5 text-ember" />
          <div className="flex-1">
            <div className="text-base font-semibold text-ink">{t('mobile.title') || '手机入口'}</div>
            <div className="text-[11px] text-ink-fade">
              {t('mobile.subtitle') || '生成 access key，在手机/局域网浏览器打开 /mobile.html 即可登录使用。'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="h-8 px-3 bg-ember text-paper rounded-md text-xs hover:bg-ember/90 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('mobile.new') || '新建 Key'}
          </button>
        </div>

        <div className="flex-1 overflow-auto p-6">
          {loading && <div className="text-sm text-ink-fade">{t('mobile.loading') || '加载中…'}</div>}
          {err && <div className="text-sm text-rose-700 mb-3">{err}</div>}

          {!loading && keys.length === 0 && (
            <div className="text-center text-sm text-ink-fade py-20">
              {t('mobile.empty') || '还没有 access key，点「新建 Key」开始'}
            </div>
          )}

          {keys.length > 0 && (
            <div className="max-w-3xl mx-auto flex flex-col gap-2">
              {keys.map((k) => (
                <div key={k.id} className="border border-ink/10 rounded-md p-3 bg-paper-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink truncate">
                      {k.label || (t('mobile.noLabel') || '(无标签)')}
                    </div>
                    <div className="text-[11px] text-ink-fade mt-0.5 flex flex-wrap gap-x-3">
                      <span>{t('mobile.created') || '创建'}：{fmtTs(k.createdAt)}</span>
                      <span>{t('mobile.lastUsed') || '上次使用'}：{fmtTs(k.lastUsedAt)}</span>
                      <span>{t('mobile.ttl') || '有效期'}：{fmtTtl(k)}</span>
                      <span className="font-mono">{k.prefix}…</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRevoke(k.id)}
                    className="h-8 px-2 rounded-md border border-ink/10 hover:bg-rose-50 text-rose-700 text-xs flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('mobile.revoke') || '撤销'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 创建对话框 */}
        {showCreate && (
          <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50">
            <div className="bg-paper rounded-md border border-ink/10 p-5 w-[420px] max-w-[90vw] flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div className="text-base font-semibold text-ink flex-1">
                  {t('mobile.createTitle') || '新建 access key'}
                </div>
                <button type="button" onClick={() => setShowCreate(false)} className="text-ink-fade hover:text-ink">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <label className="text-xs text-ink-soft">
                {t('mobile.label') || '标签（可选）'}
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="iPhone 15 / 客厅 iPad"
                  className="w-full mt-1 border border-ink/10 rounded-md px-2 py-1.5 text-sm bg-paper-2 outline-none focus:border-ember/40"
                />
              </label>
              <label className="text-xs text-ink-soft">
                {t('mobile.ttlHours') || '有效期（小时，留空 = 永久）'}
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={newTtlHours}
                  onChange={(e) => setNewTtlHours(e.target.value)}
                  placeholder="24"
                  className="w-full mt-1 border border-ink/10 rounded-md px-2 py-1.5 text-sm bg-paper-2 outline-none focus:border-ember/40"
                />
              </label>
              <div className="flex items-center gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="h-8 px-3 rounded-md border border-ink/10 text-xs text-ink-soft hover:bg-paper-2"
                >
                  {t('mobile.cancel') || '取消'}
                </button>
                <button
                  type="button"
                  onClick={onCreate}
                  disabled={creating}
                  className="h-8 px-3 rounded-md bg-ember text-paper text-xs hover:bg-ember/90 disabled:opacity-60"
                >
                  {creating ? (t('mobile.creating') || '创建中…') : (t('mobile.create') || '创建')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* show-once 显示明文 key */}
        {revealed && (
          <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50">
            <div className="bg-paper rounded-md border border-ember/40 p-5 w-[520px] max-w-[90vw] flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <div className="text-base font-semibold text-ink flex-1">
                  {t('mobile.revealTitle') || '只显示一次，请立即复制'}
                </div>
                <button type="button" onClick={() => setRevealed(null)} className="text-ink-fade hover:text-ink">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="text-xs text-ink-fade">
                {t('mobile.revealHint') || '此 key 仅显示这一次。关闭对话框后无法再次查看，但可在列表中撤销。'}
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
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? (t('mobile.copied') || '已复制') : (t('mobile.copy') || '复制')}
                </button>
                <button
                  type="button"
                  onClick={() => setRevealed(null)}
                  className="h-8 px-3 rounded-md bg-ember text-paper text-xs hover:bg-ember/90"
                >
                  {t('mobile.done') || '我已保存'}
                </button>
              </div>
              <div className="text-[11px] text-ink-fade pt-1 border-t border-ink/5">
                {t('mobile.howTo') || '使用方法：手机浏览器打开'} <span className="font-mono">/mobile.html</span> {t('mobile.thenPaste') || '，粘贴此 key 即可登录。'}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
