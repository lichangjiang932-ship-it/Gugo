export { AnimatePresence } from 'framer-motion'
export { HostMotionProvider, useMotionPreference } from './motionPreference.js'
import { HostMotionDiv, HostMotionAside } from '../components/ui/HostMotionElement.jsx'
export const motion = Object.freeze({ div: HostMotionDiv, aside: HostMotionAside })
