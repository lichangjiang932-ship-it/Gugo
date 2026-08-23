import fs from 'node:fs'
import path from 'node:path'

export const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR && path.isAbsolute(process.env.ARTIFACT_DIR)
    ? process.env.ARTIFACT_DIR
    : path.resolve(process.cwd(), process.env.ARTIFACT_DIR || '.artifacts')

const FORBIDDEN_FILENAME_CHARACTERS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

export function ensureArtifactDir() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  return ARTIFACT_DIR
}

export function hasUnsafeFilenameCharacter(value) {
  return Array.from(String(value || '')).some((character) => {
    const code = character.codePointAt(0)
    return code <= 31 || code === 127 || FORBIDDEN_FILENAME_CHARACTERS.has(character)
  })
}

export function isSafeArtifactFilename(filename) {
  const value = String(filename || '')
  return value.length > 0 && value.length <= 240
    && value === path.basename(value) && value !== '.' && value !== '..'
    && !hasUnsafeFilenameCharacter(value)
    && /^\.[a-z0-9]{1,12}$/i.test(path.extname(value))
}

export function replaceUnsafeFilenameCharacters(value) {
  return Array.from(String(value || ''), (character) => {
    const code = character.codePointAt(0)
    return code <= 31 || code === 127 || FORBIDDEN_FILENAME_CHARACTERS.has(character) ? ' ' : character
  }).join('')
}

export function getArtifactDir() {
  return ARTIFACT_DIR
}
