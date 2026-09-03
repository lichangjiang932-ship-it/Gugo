import ErrorBoundary from './ErrorBoundary.jsx'
import { useLocation } from '../lib/router.jsx'

export default function RouteErrorBoundary({ children, fallbackWrapper }) {
  const location = useLocation()
  const routeKey = `${location.pathname}${location.search}`
  return (
    <ErrorBoundary key={routeKey} fallbackWrapper={fallbackWrapper}>
      {children}
    </ErrorBoundary>
  )
}
