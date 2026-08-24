import { Bell, Camera, Database, FilePen, FileText, HardDrive, Mic, Terminal } from 'lucide-react'

export const PERMISSION_ITEMS = [
  { id: 'localStorage', icon: Database, nameKey: 'itemLocalStorageName', scopeKey: 'itemLocalStorageScope', requestable: false },
  { id: 'storage', icon: HardDrive, nameKey: 'itemStorageName', scopeKey: 'itemStorageScope', requestable: false },
  { id: 'notifications', icon: Bell, nameKey: 'itemNotificationsName', scopeKey: 'itemNotificationsScope', requestable: true },
  { id: 'microphone', icon: Mic, nameKey: 'itemMicName', scopeKey: 'itemMicScope', requestable: true },
  { id: 'camera', icon: Camera, nameKey: 'itemCameraName', scopeKey: 'itemCameraScope', requestable: true },
]

export const STATE_COLOR = { granted: 'text-success', denied: 'text-danger', prompt: 'text-warning', unsupported: 'text-ink-fade', unknown: 'text-ink-fade' }
export const STATE_DOT = { granted: 'bg-success', denied: 'bg-danger', prompt: 'bg-warning', unsupported: 'bg-ink-fade', unknown: 'bg-ink-fade' }
export const STATE_KEY = { granted: 'stateGranted', denied: 'stateDenied', prompt: 'statePrompt', unsupported: 'stateUnsupported', unknown: 'stateUnknown' }
export const TOOL_ICONS = { bash_exec: Terminal, write_file: FilePen, edit_file: FileText }

export function emptyPermissionResults() {
  return Object.fromEntries(PERMISSION_ITEMS.map((item) => [item.id, { state: 'unknown', detail: null }]))
}
