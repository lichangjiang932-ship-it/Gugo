import { useRef, useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import CoverScene from './CoverScene'

export default function CoverPage() {
  const navigate = useNavigate()
  const isExiting = useRef(false)
  const [showContent, setShowContent] = useState(false)
  const [exitPhase, setExitPhase] = useState(false)
  const mouseRef = useRef({ x: 0, y: 0 })
  const contentRef = useRef(null)

  // Entrance delay — show text after 3D scene starts rendering
  useEffect(() => {
    const timer = setTimeout(() => setShowContent(true), 100)
    return () => clearTimeout(timer)
  }, [])

  // Mouse parallax for text layer
  useEffect(() => {
    const onMouseMove = (e) => {
      mouseRef.current.x = (e.clientX / window.innerWidth - 0.5) * 2
      mouseRef.current.y = (e.clientY / window.innerHeight - 0.5) * 2
      if (contentRef.current) {
        const px = -mouseRef.current.x * 10
        const py = -mouseRef.current.y * 10
        contentRef.current.style.transform = `translate(${px}px, ${py}px)`
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [])

  // Handle enter — navigate to /chat with exit animation
  const handleEnter = useCallback(() => {
    if (isExiting.current) return
    isExiting.current = true
    setExitPhase(true)
    setTimeout(() => {
      navigate('/chat')
    }, 1200)
  }, [navigate])

  // Keyboard / click listeners
  useEffect(() => {
    const onKeyDown = () => handleEnter()
    const onClick = () => handleEnter()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('click', onClick)
    }
  }, [handleEnter])

  if (exitPhase) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        background: '#1a1510',
        cursor: 'pointer',
        zIndex: 100,
      }}
    >
      {/* 3D Canvas Layer */}
      <CoverScene isExiting={isExiting} />

      {/* Vignette overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse at center, transparent 40%, rgba(26,21,16,0.7) 100%)',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />

      {/* Text Content Layer */}
      <AnimatePresence>
        {!exitPhase && (
          <motion.div
            ref={contentRef}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 2,
              pointerEvents: 'none',
            }}
            exit={{
              opacity: 0,
              y: -80,
              transition: { duration: 0.8, ease: [0.76, 0, 0.24, 1] },
            }}
          >
            {/* Logo Icon */}
            <motion.div
              initial={{ opacity: 0, scale: 0.5 }}
              animate={showContent ? { opacity: 1, scale: 1 } : {}}
              transition={{ duration: 0.8, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
              style={{ marginBottom: 24 }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  border: '1px solid rgba(244, 239, 229, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(26, 21, 16, 0.6)',
                  backdropFilter: 'blur(8px)',
                }}
              >
                <Sparkles
                  size={24}
                  style={{ color: '#E86A3C' }}
                  strokeWidth={1.5}
                />
              </div>
            </motion.div>

            {/* Main Title */}
            <motion.h1
              initial={{ opacity: 0, y: 40 }}
              animate={showContent ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.7, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
              style={{
                fontFamily: '"Cormorant Garamond", Georgia, serif',
                fontSize: 'clamp(36px, 5vw, 56px)',
                fontWeight: 600,
                fontStyle: 'italic',
                color: '#f4efe5',
                letterSpacing: '0.02em',
                textAlign: 'center',
                margin: 0,
                textShadow: '0 0 60px rgba(232, 106, 60, 0.15)',
              }}
            >
              Your Model Atelier
            </motion.h1>

            {/* Subtitle */}
            <motion.p
              initial={{ opacity: 0, y: 25 }}
              animate={showContent ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.6, delay: 0.7, ease: [0.16, 1, 0.3, 1] }}
              style={{
                fontFamily: 'Inter, system-ui, sans-serif',
                fontSize: 'clamp(14px, 1.8vw, 17px)',
                fontWeight: 300,
                color: '#8a7b68',
                marginTop: 12,
                letterSpacing: '0.15em',
              }}
            >
              你的 AI 模型工坊
            </motion.p>

            {/* Decorative Line */}
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={showContent ? { width: 120, opacity: 1 } : {}}
              transition={{ duration: 0.6, delay: 0.9, ease: [0.16, 1, 0.3, 1] }}
              style={{
                height: 1,
                background: 'linear-gradient(90deg, transparent, #E86A3C, transparent)',
                marginTop: 28,
                boxShadow: '0 0 12px rgba(232, 106, 60, 0.4)',
              }}
            />

            {/* Hint Text */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={showContent ? { opacity: 0.5 } : {}}
              transition={{ duration: 0.8, delay: 1.1 }}
              style={{
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                fontSize: 11,
                color: '#8a7b68',
                marginTop: 32,
                letterSpacing: '0.08em',
                animation: 'breathe 2.5s ease-in-out infinite',
              }}
            >
              按任意键或点击进入
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Exit flash overlay */}
      <AnimatePresence>
        {exitPhase && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.4 }}
            style={{
              position: 'absolute',
              inset: 0,
              background: '#1a1510',
              zIndex: 10,
              pointerEvents: 'none',
            }}
          />
        )}
      </AnimatePresence>

      {/* Keyframe styles */}
      <style>{`
        @keyframes breathe {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  )
}
