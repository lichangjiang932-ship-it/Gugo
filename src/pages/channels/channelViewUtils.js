export function groupChannels(channels) {
  return {
    dm: channels.filter((channel) => channel.kind === 'dm' && !channel.archivedAt),
    group: channels.filter((channel) => channel.kind !== 'dm' && !channel.archivedAt),
    archived: channels.filter((channel) => channel.archivedAt),
  }
}

export function agentLabel(agent) {
  return agent?.name || agent?.id || 'Agent'
}
