import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/** A scoped, display-only receipt. Clearing/dismissing it never decides or replays a request. */
export default function useApprovalDecisionNotice(presentationScope) {
  const [notice, setNotice] = useState(null)
  const scopeRef = useRef(presentationScope)
  useLayoutEffect(() => { scopeRef.current = presentationScope }, [presentationScope])
  const isCurrentApprovalScope = useCallback(scope => scopeRef.current === scope, [])
  const dismissApprovalNotice = useCallback(() => setNotice(null), [])
  const publishApprovalNotice = useCallback((value, request, scope) => {
    if (scopeRef.current !== scope) return false
    setNotice({ ...value, id: String(request?.id || '').slice(0, 256),
      toolName: typeof request?.name === 'string' ? request.name.slice(0, 160) : '', scope })
    return true
  }, [])
  return { approvalNotice: notice?.scope === presentationScope ? notice : null,
    dismissApprovalNotice, isCurrentApprovalScope, publishApprovalNotice }
}
