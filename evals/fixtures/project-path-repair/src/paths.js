import path from 'node:path'
export function resolveTarget(projectRoot, target) {
  return path.resolve(target)
}
