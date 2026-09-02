function cloneRequirements(requirements = {}) {
  return {
    app: !!requirements.app,
    mcp: !!requirements.mcp,
    runtime: Array.isArray(requirements.runtime) ? [...requirements.runtime] : [],
  }
}

export function cloneCodexPluginSkill(skill) {
  return {
    ...skill,
    permissions: [...(skill.permissions || [])],
    perms: [...(skill.perms || [])],
    requirements: cloneRequirements(skill.requirements),
    source: skill.source ? { ...skill.source } : null,
  }
}

export function cloneCodexPlugin(plugin) {
  return {
    ...plugin,
    requirements: cloneRequirements(plugin.requirements),
    source: plugin.source ? { ...plugin.source } : null,
  }
}
