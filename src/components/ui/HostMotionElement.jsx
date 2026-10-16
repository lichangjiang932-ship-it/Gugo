import { forwardRef, useContext, useEffect, useMemo } from 'react'
import { motion as nativeMotion, useAnimationControls } from 'framer-motion'
import { MotionEnabled } from '../../lib/motionPreference.js'
const encode = value => JSON.stringify(value, (_, item) => item === Infinity ? '__host_infinity__' : item)
const decode = key => JSON.parse(key, (_, item) => item === '__host_infinity__' ? Infinity : item)
function finalFrame(target) {
  return Object.fromEntries(Object.entries(target || {}).map(([key, value]) => [key, Array.isArray(value) ? value.at(-1) : value]))
}
const HostMotionElement = forwardRef(function HostMotionElement({ tag, initial, animate, exit, transition, layout, layoutId, ...props }, ref) {
    const enabled = useContext(MotionEnabled)
    const controls = useAnimationControls()
    // These local host call sites use small declarative geometry/opacity targets.
    // Stable values must not restart entry animation on unrelated parent renders.
    const targetKey = encode(animate || {})
    const timingKey = encode(transition || {})
    const target = useMemo(() => decode(targetKey), [targetKey])
    const timing = useMemo(() => decode(timingKey), [timingKey])
    useEffect(() => {
      controls.stop()
      if (enabled) void controls.start({ ...target, transition: timing })
      else controls.set(finalFrame(target))
      return () => controls.stop()
    }, [controls, enabled, target, timing])
    const Component = nativeMotion[tag]
    return <Component {...props} ref={ref} initial={enabled ? initial : false} animate={controls}
      exit={enabled ? exit : undefined} transition={enabled ? transition : { duration: 0 }}
      layout={enabled ? layout : false} layoutId={enabled ? layoutId : undefined} />
})

export const HostMotionDiv = forwardRef(function HostMotionDiv(props, ref) { return <HostMotionElement {...props} ref={ref} tag="div" /> })
export const HostMotionAside = forwardRef(function HostMotionAside(props, ref) { return <HostMotionElement {...props} ref={ref} tag="aside" /> })
