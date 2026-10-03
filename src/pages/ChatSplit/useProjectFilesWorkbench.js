import { useEffect, useState } from 'react'

export default function useProjectFilesWorkbench() {
  const [workbenchMessage, setWorkbenchMessage] = useState('')
  useEffect(() => {
    if (!workbenchMessage) return undefined
    const timer = setTimeout(() => setWorkbenchMessage(''), 5000)
    return () => clearTimeout(timer)
  }, [workbenchMessage])

  return { workbenchMessage, setWorkbenchMessage }
}
