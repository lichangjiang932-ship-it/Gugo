import DesktopPet from '../DesktopPet.jsx'

/**
 * The desktop pet's host in the chat view.
 *
 * Extracted so the chat view itself stays inside its component size budget: the
 * pet is a self-contained decoration that reads the same conversation state and
 * belongs nowhere in the view's own markup.
 *
 * In the desktop shell the pet is a real window of its own, so the in-page copy
 * stays out of the way there.
 */
export default function ChatDesktopPetHost({ isGenerating, messages, onClose, tasks, toolApproval, visible }) {
  if (!visible || typeof window !== 'undefined' && window.gugoDesktop?.isDesktop) return null
  return (
    <DesktopPet
      onClose={onClose}
      isGenerating={isGenerating}
      messages={messages}
      tasks={tasks}
      toolApproval={toolApproval}
    />
  )
}
