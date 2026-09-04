import { useEffect } from 'react'

export default function useProjectFilesWorkbench({ setWorkbenchOpen, setWorkbenchTab }) {
  useEffect(() => {
    const openProjectFiles = () => {
      setWorkbenchTab('files')
      setWorkbenchOpen(true)
    }
    window.addEventListener('chat-workbench:open-files', openProjectFiles)
    return () => window.removeEventListener('chat-workbench:open-files', openProjectFiles)
  }, [setWorkbenchOpen, setWorkbenchTab])
}
