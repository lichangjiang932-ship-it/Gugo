let prepareInlineSkills = () => []

export function configureInlineSkillPromptPreparer(prepare) {
  if (typeof prepare !== 'function') {
    throw new TypeError('inline skill prompt preparer must be a function')
  }
  prepareInlineSkills = prepare
}

export function prepareBoundInlineSkillsForPrompt(input = {}) {
  return prepareInlineSkills(input)
}
