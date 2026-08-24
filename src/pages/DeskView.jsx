/**
 * DeskView — Hanako 平行：书桌便笺
 *
 * 设计要点：
 * - 左栏笔记列表（pinned 排前 + updated_at desc），右栏编辑器
 * - 全局 / 当前 agent 两个视图（agentId === null 仅未绑定；undefined 全部）
 * - 钉选 / 标题 / 正文，自动 PATCH（防抖 600ms）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Pin, PinOff, NotebookPen, Loader2 } from 'lucide-react'
import AppLayout from '../components/AppLayout.jsx'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  listDeskNotesApi,
  createDeskNoteApi,
  updateDeskNoteApi,
  deleteDeskNoteApi,
} from '../lib/deskClient.js'

export default function DeskView() {
  const t = useT()
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [draft, setDraft] = useState({ title: '', body: '', pinned: false })
  const [saving, setSaving] = useState(false)
  const saveTimer = useRef(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const data = await listDeskNotesApi({ agent: 'all' })
      setNotes(data.notes || [])
      // 保活：若 activeId 仍在则保留，否则选第一条
      if (data.notes?.length) {
        setActiveId((prev) => (prev && data.notes.some((n) => n.id === prev) ? prev : data.notes[0].id))
      } else {
        setActiveId(null)
      }
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => { reload() }, 0)
    return () => {
      window.clearTimeout(t)
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [reload])

  const active = useMemo(() => notes.find((n) => n.id === activeId) || null, [notes, activeId])

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (active) {
        setDraft({ title: active.title || '', body: active.body || '', pinned: !!active.pinned })
      } else {
        setDraft({ title: '', body: '', pinned: false })
      }
    }, 0)
    return () => window.clearTimeout(t)
  }, [activeId, active?.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const flushSave = useCallback(async (id, patch) => {
    setSaving(true)
    try {
      const data = await updateDeskNoteApi(id, patch)
      setNotes((prev) => prev.map((n) => (n.id === id ? data.note : n)).sort((a, b) => {
        if ((b.pinned ? 1 : 0) !== (a.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
        return (b.updatedAt || 0) - (a.updatedAt || 0)
      }))
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setSaving(false)
    }
  }, [])

  const scheduleSave = useCallback((next) => {
    if (!activeId) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      flushSave(activeId, next)
    }, 600)
  }, [activeId, flushSave])

  const onCreate = async () => {
    setErr('')
    try {
      const data = await createDeskNoteApi({ title: t('desk.untitled') || '新便笺', body: '' })
      await reload()
      setActiveId(data.note.id)
    } catch (e) {
      setErr(e.message || String(e))
    }
  }

  const onDelete = async (id) => {
    if (!window.confirm(t('desk.confirmDelete') || '删除该便笺?')) return
    try {
      await deleteDeskNoteApi(id)
      if (activeId === id) setActiveId(null)
      await reload()
    } catch (e) {
      setErr(e.message || String(e))
    }
  }

  const onTogglePin = async () => {
    if (!active) return
    const next = { pinned: !draft.pinned }
    setDraft((d) => ({ ...d, pinned: !d.pinned }))
    await flushSave(active.id, next)
  }

  const onTitle = (v) => {
    setDraft((d) => ({ ...d, title: v }))
    scheduleSave({ title: v })
  }
  const onBody = (v) => {
    setDraft((d) => ({ ...d, body: v }))
    scheduleSave({ body: v })
  }

  return (
    <AppLayout className="h-screen flex bg-paper overflow-hidden">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
          <NotebookPen className="w-5 h-5 text-accent-ink" />
          <div className="flex-1">
            <div className="text-base font-semibold text-ink">{t('desk.title') || '书桌'}</div>
            <div className="text-xs text-ink-fade">
              {t('desk.subtitle') || '随手便笺、灵感、TODO；自动保存，钉选置顶。'}
            </div>
          </div>
          {saving && <Loader2 className="w-4 h-4 text-ink-fade animate-spin" />}
          <button
            type="button"
            onClick={onCreate}
            className="h-8 px-3 bg-accent text-accent-contrast rounded-md text-xs hover:bg-accent/90 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('desk.new') || '新建'}
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-[320px] border-r border-ink/10 overflow-auto">
            {loading && <div className="p-4 text-sm text-ink-fade">{t('desk.loading') || '加载中…'}</div>}
            {err && <div className="p-4 text-sm text-danger">{err}</div>}
            {!loading && notes.length === 0 && (
              <div className="p-6 text-center text-sm text-ink-fade">
                {t('desk.empty') || '还没有便笺，点「新建」开始'}
              </div>
            )}
            {notes.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setActiveId(n.id)}
                className={`w-full text-left border-b border-ink/5 px-4 py-3 hover:bg-paper-2 ${
                  activeId === n.id ? 'bg-accent/10' : ''
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {n.pinned && <Pin className="w-3 h-3 text-accent-ink" />}
                  <span className="text-xs font-medium text-ink truncate flex-1">
                    {n.title || (t('desk.untitled') || '未命名')}
                  </span>
                </div>
                <div className="text-xs text-ink-fade truncate mt-0.5">{n.body || ' '}</div>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto p-6">
            {!active ? (
              <div className="text-sm text-ink-fade text-center mt-20">
                {t('desk.pickOne') || '从左侧选一条便笺，或点「新建」'}
              </div>
            ) : (
              <div className="max-w-2xl mx-auto flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={draft.title}
                    onChange={(e) => onTitle(e.target.value)}
                    placeholder={t('desk.titlePlaceholder') || '标题'}
                    className="flex-1 text-lg font-medium bg-transparent border-b border-ink/10 focus:border-focus/60 outline-none py-1.5 text-ink"
                  />
                  <button
                    type="button"
                    onClick={onTogglePin}
                    className="h-8 px-2 rounded-md border border-ink/10 hover:bg-paper-2 text-ink-soft flex items-center gap-1 text-xs"
                    title={draft.pinned ? (t('desk.unpin') || '取消置顶') : (t('desk.pin') || '置顶')}
                  >
                    {draft.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                    {draft.pinned ? (t('desk.pinned') || '已置顶') : (t('desk.pin') || '置顶')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(active.id)}
                    className="h-8 px-2 rounded-md border border-ink/10 hover:bg-danger/5 text-danger text-xs flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('desk.delete') || '删除'}
                  </button>
                </div>
                <textarea
                  value={draft.body}
                  onChange={(e) => onBody(e.target.value)}
                  placeholder={t('desk.bodyPlaceholder') || '在这里随手写点什么…'}
                  className="flex-1 min-h-[60vh] resize-none bg-paper-2 border border-ink/10 rounded-md p-4 text-sm leading-relaxed text-ink outline-none focus:border-focus/40 font-mono"
                />
                <div className="text-xs text-ink-fade text-right">
                  {(t('desk.savedAt') || '更新于')} {new Date(active.updatedAt).toLocaleString()}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  )
}
