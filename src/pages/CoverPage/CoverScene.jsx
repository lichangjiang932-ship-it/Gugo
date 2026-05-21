import { useRef, useMemo, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import * as THREE from 'three'

/* ─── Internal Core Sphere (pulsing) ─── */
function CoreSphere({ isExiting }) {
  const meshRef = useRef()
  const scaleRef = useRef(0)

  useFrame((state, delta) => {
    if (!meshRef.current) return
    // Entrance animation
    if (scaleRef.current < 1 && !isExiting.current) {
      scaleRef.current = Math.min(1, scaleRef.current + delta * 1.5)
    }
    // Exit animation
    if (isExiting.current) {
      scaleRef.current = Math.max(0, scaleRef.current - delta * 2)
    }
    // Breathing pulse
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 1.5) * 0.05
    const s = scaleRef.current * pulse
    meshRef.current.scale.set(s, s, s)
  })

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[0.8, 32, 32]} />
      <meshBasicMaterial
        color="#E86A3C"
        transparent
        opacity={0.08}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

/* ─── Wireframe Icosphere ─── */
function WireSphere({ isExiting }) {
  const meshRef = useRef()
  const scaleRef = useRef(0)
  const rotSpeedRef = useRef({ x: 0.0005, y: 0.001 })
  const mouseRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const onMouseMove = (e) => {
      mouseRef.current.x = (e.clientX / window.innerWidth - 0.5) * 2
      mouseRef.current.y = (e.clientY / window.innerHeight - 0.5) * 2
    }
    window.addEventListener('mousemove', onMouseMove)
    return () => window.removeEventListener('mousemove', onMouseMove)
  }, [])

  useFrame((state, delta) => {
    if (!meshRef.current) return

    // Entrance / exit scale
    if (!isExiting.current && scaleRef.current < 1) {
      scaleRef.current = Math.min(1, scaleRef.current + delta * 1.25)
    }
    if (isExiting.current) {
      scaleRef.current = Math.max(0, scaleRef.current - delta * 1.8)
      rotSpeedRef.current.y += delta * 0.01
    }

    const s = scaleRef.current
    meshRef.current.scale.set(s, s, s)

    // Rotation with mouse influence
    const mouseX = mouseRef.current.x
    const mouseY = mouseRef.current.y
    meshRef.current.rotation.y += rotSpeedRef.current.y * (1 + mouseX * 0.5)
    meshRef.current.rotation.x += rotSpeedRef.current.x * (1 + mouseY * 0.5)
  })

  return (
    <mesh ref={meshRef}>
      <icosahedronGeometry args={[2.5, 2]} />
      <meshBasicMaterial
        color="#E86A3C"
        wireframe
        transparent
        opacity={0.12}
      />
    </mesh>
  )
}

/* ─── Particle System ─── */
function Particles({ isExiting }) {
  const pointsRef = useRef()
  const scaleRef = useRef(0)
  const timeRef = useRef(0)

  /* eslint-disable react-hooks/purity */
  function genParticleData() {
    const count = 2000
    const pos = new Float32Array(count * 3)
    const rnd = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 2.0 + Math.random() * 2.0
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      pos[i * 3 + 2] = r * Math.cos(phi)
      rnd[i] = Math.random() * Math.PI * 2
    }
    return { positions: pos, randoms: rnd }
  }
  /* eslint-enable react-hooks/purity */

  const { positions, randoms } = useMemo(() => genParticleData(), [])

  useFrame((state, delta) => {
    if (!pointsRef.current) return
    timeRef.current += delta

    // Entrance / exit
    if (!isExiting.current && scaleRef.current < 1) {
      scaleRef.current = Math.min(1, scaleRef.current + delta * 1.0)
    }
    if (isExiting.current) {
      scaleRef.current = Math.max(0, scaleRef.current - delta * 1.5)
    }

    const s = scaleRef.current
    pointsRef.current.scale.set(s, s, s)

    // Gentle rotation
    pointsRef.current.rotation.y += delta * 0.0008
    pointsRef.current.rotation.x += delta * 0.0003

    // Twinkle effect via position wobble
    const posArray = pointsRef.current.geometry.attributes.position.array
    const t = timeRef.current
    for (let i = 0; i < 2000; i++) {
      const rnd = randoms[i]
      const wobble = Math.sin(t * 0.5 + rnd) * 0.02
      const idx = i * 3
      const originalR = 2.0 + (Math.abs(positions[idx]) + Math.abs(positions[idx + 1]) + Math.abs(positions[idx + 2])) / 3 * 0.5
      const factor = 1 + wobble / originalR
      posArray[idx] = positions[idx] * factor
      posArray[idx + 1] = positions[idx + 1] * factor
      posArray[idx + 2] = positions[idx + 2] * factor
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true
  })

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={2000}
          array={positions}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        color="#f4efe5"
        size={0.018}
        transparent
        opacity={0.5}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  )
}

/* ─── Cyan Ring ─── */
function Ring({ isExiting }) {
  const meshRef = useRef()
  const scaleRef = useRef(0)

  useFrame((state, delta) => {
    if (!meshRef.current) return

    if (!isExiting.current && scaleRef.current < 1) {
      scaleRef.current = Math.min(1, scaleRef.current + delta * 1.0)
    }
    if (isExiting.current) {
      scaleRef.current = Math.max(0, scaleRef.current - delta * 1.5)
    }

    const s = scaleRef.current
    meshRef.current.scale.set(s, s, s)
    meshRef.current.rotation.z += delta * 0.002
  })

  return (
    <mesh ref={meshRef} rotation={[Math.PI / 2.5, 0, 0]}>
      <ringGeometry args={[3.2, 3.28, 128]} />
      <meshBasicMaterial
        color="#2E8FA3"
        transparent
        opacity={0.25}
        side={THREE.DoubleSide}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  )
}

/* ─── Scene Composition ─── */
function Scene({ isExiting }) {
  return (
    <>
      <ambientLight intensity={0.3} />
      <CoreSphere isExiting={isExiting} />
      <WireSphere isExiting={isExiting} />
      <Particles isExiting={isExiting} />
      <Ring isExiting={isExiting} />
      <EffectComposer>
        <Bloom
          intensity={0.6}
          luminanceThreshold={0.2}
          luminanceSmoothing={0.9}
          mipmapBlur
        />
      </EffectComposer>
    </>
  )
}

/* ─── Canvas Wrapper ─── */
export default function CoverScene({ isExiting }) {
  return (
    <Canvas
      camera={{ position: [0, 0, 8], fov: 50 }}
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      }}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: '#1a1510',
      }}
    >
      <Scene isExiting={isExiting} />
    </Canvas>
  )
}
