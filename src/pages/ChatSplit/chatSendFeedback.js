/** Send rejection must be visible even when the workbench is closed. */
export function presentChatSendBlocked(reason, { t, setWorkbenchMessage, toast }) {
  const key = reason === 'owner-changed' ? 'errors.turnExecutionContextChanged'
    : reason === 'directory-approval' ? 'chatSteering.directoryAuthorizationRequired'
    : reason === 'send-pending' ? 'chatSteering.sendPending' : 'chatSteering.turnRunning'
  const message = t(key)
  setWorkbenchMessage(message)
  toast.info(message)
}
