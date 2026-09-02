import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The Node entry may be launched through npm --prefix, an IDE, or another
// shell directory. Keep its project-owned config and default persistence
// identity attached to this installed application instead of the caller cwd.
export const SERVER_APPLICATION_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
