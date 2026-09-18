import { CliError } from './errors.js'

function discardBufferedInput(stdin) {
  if (typeof stdin?.read !== 'function') return
  while (stdin.read() !== null) { /* Pretyped bytes never select or approve an action. */ }
}

/** The picker is a temporary input owner, never a second reader beside the editor. */
export async function chooseModelInteractively({ catalog, current, stdin, stdout, reader, signal, scripted = false,
  selectModel = async (options, context) => (await import('@inquirer/prompts')).select(options, context) }) {
  await catalog.refresh()
  const entries = catalog.entries().filter((entry) => entry.enabled)
  if (scripted || entries.length === 0 || stdin?.isTTY !== true || stdout?.isTTY !== true || signal?.aborted) return null
  reader.suspend()
  discardBufferedInput(stdin)
  try {
    const value = await selectModel({
      message: 'Select a model',
      default: entries.find((entry) => entry.modelName === current.model && entry.providerId === current.modelProviderId),
      choices: entries.map((entry) => ({ name: entry.displayName, value: entry })),
    }, { input: stdin, output: stdout, signal })
    if (signal?.aborted) return null
    return value ? await catalog.select(value, { currentProviderId: current.modelProviderId }) : null
  } catch (error) {
    if (signal?.aborted || ['ExitPromptError', 'AbortPromptError'].includes(error?.name)) return null
    if (error?.code) throw error
    throw new CliError('CLI_MODEL_PICKER_FAILED', 'Model selection failed; the previous model is unchanged.')
  } finally { discardBufferedInput(stdin) }
}
