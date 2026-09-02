export class CliError extends Error {
  constructor(code, message, exitCode = 1, options = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
    if (Number.isInteger(options.statusCode)) this.statusCode = options.statusCode
  }
}

export class CliUsageError extends CliError {
  constructor(code, message) {
    super(code, message, 2)
    this.name = 'CliUsageError'
  }
}
