import { LoaderCircle } from 'lucide-react'
import './LoadingState.css'

/** Visual-only primitives; their owning status region supplies the localized label. */
export function Spinner({ className = '', ...props }) {
  return <LoaderCircle aria-hidden="true" {...props} className={'gugo-spinner animate-spin motion-reduce:animate-none ' + className} />
}
export function ProgressDots({ className = '' }) {
  return <span className={'gugo-progress-dots ' + className} aria-hidden="true"><i /><i /><i /></span>
}
export function Skeleton({ className = '' }) {
  return <span className={'gugo-skeleton ' + className} aria-hidden="true" />
}
