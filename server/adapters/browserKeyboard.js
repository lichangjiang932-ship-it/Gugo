const KEY_DEFINITIONS = Object.freeze({
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
})

const KEY_ALIASES = Object.freeze({
  esc: 'Escape',
  return: 'Enter',
  spacebar: 'Space',
  left: 'ArrowLeft',
  up: 'ArrowUp',
  right: 'ArrowRight',
  down: 'ArrowDown',
  del: 'Delete',
})

export function keyEventParams(rawKey) {
  const raw = String(rawKey || '').trim()
  if (!raw || raw.length > 64) throw new Error('请输入有效按键（例如 Enter、Tab 或 Control+A）')
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean)
  const mainRaw = parts.pop()
  let modifiers = 0
  for (const modifier of parts) {
    const normalized = modifier.toLowerCase()
    if (normalized === 'alt') modifiers |= 1
    else if (normalized === 'control' || normalized === 'ctrl') modifiers |= 2
    else if (normalized === 'meta' || normalized === 'command' || normalized === 'cmd') modifiers |= 4
    else if (normalized === 'shift') modifiers |= 8
    else throw new Error(`不支持的组合键修饰符: ${modifier}`)
  }

  const aliased = KEY_ALIASES[String(mainRaw || '').toLowerCase()] || mainRaw
  const definition = KEY_DEFINITIONS[aliased]
  if (definition) {
    return {
      key: aliased === 'Space' ? ' ' : aliased,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
      modifiers,
      ...(definition.text && !(modifiers & 7) ? { text: definition.text, unmodifiedText: definition.text } : {}),
    }
  }

  const characters = [...String(aliased || '')]
  if (characters.length !== 1) throw new Error(`不支持的按键: ${mainRaw}`)
  const character = characters[0]
  const upper = character.toUpperCase()
  const isLetter = /^[A-Za-z]$/.test(character)
  const isDigit = /^[0-9]$/.test(character)
  const keyCode = isLetter || isDigit ? upper.charCodeAt(0) : character.codePointAt(0)
  const eventKey = isLetter && (modifiers & 7) && !(modifiers & 8) ? character.toLowerCase() : character
  const text = modifiers & 7 ? '' : ((modifiers & 8) && isLetter ? upper : eventKey)
  return {
    key: text || eventKey,
    code: isLetter ? `Key${upper}` : isDigit ? `Digit${character}` : '',
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
    ...(text ? { text, unmodifiedText: character } : {}),
  }
}
