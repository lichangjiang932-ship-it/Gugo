import { getAuthToken } from './accountClient.js'
import { desktopFileError, desktopFileOpenPolicy, desktopFileReferenceFromUrl } from '../../shared/desktopFileReference.js'

function desktopContext() {
  return typeof window === 'undefined' ? {} : { bridge: window.gugoDesktop, origin: window.location.origin }
}

export function desktopFileCapabilities(file, { bridge, origin } = desktopContext()) {
  const reference = desktopFileReferenceFromUrl(file?.url, origin)
  const supported = bridge?.isDesktop === true && typeof bridge.fileAction === 'function' && !!reference
  return {
    reference, supported, canReveal: supported,
    canOpen: supported && desktopFileOpenPolicy(file?.filename || file?.title).allowed,
  }
}

export async function openDesktopFile(file, action, {
  bridge, origin, authToken = getAuthToken(),
} = desktopContext()) {
  const capabilities = desktopFileCapabilities(file, { bridge, origin })
  if (!capabilities.supported) throw desktopFileError('DESKTOP_FILE_UNAVAILABLE')
  if (!['open', 'reveal'].includes(action)) throw desktopFileError('DESKTOP_FILE_ACTION_INVALID')
  const result = await bridge.fileAction({ action, reference: capabilities.reference, authToken })
  if (!result?.ok) throw desktopFileError(result?.error?.code || 'DESKTOP_FILE_ACTION_FAILED')
  return result
}

export function desktopFileErrorKey(code) {
  if (['PATH_NOT_AUTHORIZED', 'DESKTOP_FILE_AUTH_REQUIRED', 'UNAUTHORIZED', 'LOCAL_ONLY'].includes(code)) return 'chatPreview.fileActionDenied'
  if (['ENOENT', 'DESKTOP_FILE_NOT_FOUND', 'VERIFIED_FILE_NOT_FOUND', 'RETAINED_FILE_NOT_FOUND', 'VERIFIED_FILE_MISSING', 'RETAINED_FILE_MISSING'].includes(code)) return 'chatPreview.sourceMissing'
  if (code === 'DESKTOP_FILE_OPEN_UNSAFE') return 'chatPreview.fileOpenUnsafe'
  if (code === 'DESKTOP_FILE_CHANGED') return 'chatPreview.fileChanged'
  if (['DESKTOP_FILE_UNAVAILABLE', 'DESKTOP_FILE_BRIDGE_UNAVAILABLE', 'DESKTOP_FILE_SERVICE_UNTRUSTED'].includes(code)) return 'chatPreview.fileBridgeUnavailable'
  return 'chatPreview.fileActionFailed'
}
