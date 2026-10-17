import { SETTINGS_TAB_MODELS, settingsPathForSection } from '../../lib/settingsNavigation.js'
import { TASK_STATUS } from '../../store/taskStatus.js'

const CHAT_MODEL_SETTINGS_PATH = settingsPathForSection(SETTINGS_TAB_MODELS, [], { returnTo: '/chat' })

/** Permission and settings actions owned by the chat header and approval dock. */
export default function useChatHeaderActions({ dispatch, navigate, state, t }) {
  const handlePermAllow = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    const pending = [...state.tasks].reverse().find((task) => task.status === 'pending')
    if (pending) {
      dispatch({
        type: 'UPDATE_TASK',
        payload: { id: pending.id, updates: { status: TASK_STATUS.RUNNING, stepLabel: t('chatReliability.permissionReady') } },
      })
    }
    dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.permissionGranted') })
  }
  const handlePermDeny = () => {
    dispatch({ type: 'SET_PERM_REQUEST', payload: null })
    dispatch({ type: 'RECEIVE_MESSAGE', payload: t('chatReliability.permissionDenied') })
  }
  // The settings route owns local/multi-user authentication; navigation is not
  // a credential gate.
  const handleManageModels = () => navigate(CHAT_MODEL_SETTINGS_PATH)
  return { handleManageModels, handlePermAllow, handlePermDeny }
}
