import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import Modal from './Modal.jsx'
import { useT } from '../i18n/I18nProvider.jsx'

/**
 * FullscreenMediaModal —— 全屏媒体查看器
 *
 * 特性：
 * - 黑底 portal modal，统一 overlay/modal 层级
 * - 鼠标滚轮缩放（scale 0.25-5），按住拖拽平移
 * - 键盘：Esc 关闭、+/- 缩放、0 重置、← → 切换（需传 list）
 * - 右上角 X 按钮
 * - framer-motion 淡入淡出
 *
 * Props:
 *   - src:    string  当前媒体 URL（必填）
 *   - alt:    string  alt 文本
 *   - onClose: () => void 关闭回调
 *   - list:   string[] 可选，提供则支持 ← → 切换
 *   - index:  number   可选，当前在 list 中的位置
 *   - onIndexChange: (next:number) => void 切换回调
 */

const MIN_SCALE = 0.25
const MAX_SCALE = 5
const ZOOM_STEP = 0.2

export default function FullscreenMediaModal({
  src,
  alt = '',
  onClose,
  list = null,
  index = 0,
  onIndexChange,
}) {
  const { t } = useT()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [prevSrc, setPrevSrc] = useState(src)
  const draggingRef = useRef(null)

  // src 切换时同步重置（derived state pattern，避免 useEffect setState 级联渲染）
  if (prevSrc !== src) {
    setPrevSrc(src)
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }

  const clampScale = useCallback((s) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)), [])

  const reset = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  const goPrev = useCallback(() => {
    if (!list || !onIndexChange || list.length < 2) return
    const next = (index - 1 + list.length) % list.length
    onIndexChange(next)
  }, [list, index, onIndexChange])

  const goNext = useCallback(() => {
    if (!list || !onIndexChange || list.length < 2) return
    const next = (index + 1) % list.length
    onIndexChange(next)
  }, [list, index, onIndexChange])

  // 键盘事件
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose?.()
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        setScale((s) => clampScale(s + ZOOM_STEP))
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        setScale((s) => clampScale(s - ZOOM_STEP))
      } else if (e.key === '0') {
        e.preventDefault()
        reset()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, reset, goPrev, goNext, clampScale])

  // 滚轮缩放
  const onWheel = useCallback(
    (e) => {
      e.preventDefault()
      const delta = -e.deltaY * 0.0015
      setScale((s) => clampScale(s * (1 + delta)))
    },
    [clampScale],
  )

  // 拖拽平移
  const onPointerDown = useCallback(
    (e) => {
      if (e.button !== 0) return
      draggingRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: offset.x,
        baseY: offset.y,
      }
      setIsDragging(true)
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // ignore — jsdom 等环境可能没实现 pointer capture
      }
    },
    [offset],
  )

  const onPointerMove = useCallback((e) => {
    const d = draggingRef.current
    if (!d) return
    setOffset({
      x: d.baseX + (e.clientX - d.startX),
      y: d.baseY + (e.clientY - d.startY),
    })
  }, [])

  const onPointerUp = useCallback((e) => {
    draggingRef.current = null
    setIsDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }, [])

  if (!src) return null

  const hasList = Array.isArray(list) && list.length > 1

  return (
    <AnimatePresence>
      <Modal
        onClose={onClose}
        ariaLabel={alt || t('foundation.fullscreenMedia')}
        overlayClassName="bg-black/95 p-0 select-none touch-none overflow-hidden"
        className="h-full max-w-none overflow-hidden rounded-none border-0 bg-transparent shadow-none"
      >
        <motion.div
          key="fullscreen-media-modal"
          className="absolute inset-0 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={(e) => {
            // 点击空白处关闭（不在图片上）
            if (e.target === e.currentTarget) onClose?.()
          }}
        >
        {/* 关闭按钮 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onClose?.()
          }}
          className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title={t('foundation.closeFullscreenTitle')}
          aria-label={t('foundation.closeFullscreen')}
        >
          <X className="w-5 h-5" />
        </button>

        {/* 缩放/位置提示 */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-md bg-white/10 text-white text-xs font-mono tabular-nums pointer-events-none">
          {Math.round(scale * 100)}%
          {hasList && (
            <span className="ml-3 opacity-70">
              {index + 1} / {list.length}
            </span>
          )}
        </div>

        {/* 上一张 / 下一张 */}
        {hasList && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                goPrev()
              }}
              className="absolute left-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center text-xl"
              title={t('foundation.previousMediaTitle')}
              aria-label={t('foundation.previousMedia')}
            >
              ‹
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                goNext()
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center text-xl"
              title={t('foundation.nextMediaTitle')}
              aria-label={t('foundation.nextMedia')}
            >
              ›
            </button>
          </>
        )}

        <img
          src={src}
          alt={alt}
          draggable={false}
          className="max-w-none pointer-events-none"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            maxHeight: '90vh',
            maxWidth: '90vw',
            transition: isDragging ? 'none' : 'transform 0.06s linear',
          }}
        />
        </motion.div>
      </Modal>
    </AnimatePresence>
  )
}
