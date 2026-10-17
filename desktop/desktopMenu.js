import { Menu } from 'electron'

/**
 * On Windows and Linux the default application menu owns Ctrl+R and Ctrl+C as
 * accelerators. In a real terminal that is wrong: Ctrl+C must reach the shell as
 * SIGINT, and Ctrl+R must not reload the window out from under a running build.
 * macOS keeps its menu (Cmd-based shortcuts do not collide with the shell).
 */
export function configureDesktopApplicationMenu({ platform = process.platform } = {}) {
  if (platform === 'darwin') return
  Menu.setApplicationMenu(null)
}
