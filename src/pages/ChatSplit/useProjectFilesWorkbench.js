import { useEffect, useState } from 'react'

export default function useProjectFilesWorkbench({ setWorkbenchOpen, setWorkbenchTab }) {
  const [workbenchMessage, setWorkbenchMessage] = useState('')
  useEffect(() => {
    if (!workbenchMessage) return undefined
    const timer = setTimeout(() => setWorkbenchMessage(''), 5000)
    return () => clearTimeout(timer)
  }, [workbenchMessage])

  useEffect(() => {
    const openProjectFiles = () => {
      setWorkbenchTab('files')
      setWorkbenchOpen(true)
    }
    window.addEventListener('chat-workbench:open-files', openProjectFiles)
    return () => window.removeEventListener('chat-workbench:open-files', openProjectFiles)
  }, [setWorkbenchOpen, setWorkbenchTab])
  return { workbenchMessage, setWorkbenchMessage }
}
