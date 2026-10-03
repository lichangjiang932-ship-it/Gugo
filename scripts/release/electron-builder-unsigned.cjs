const path = require('node:path')

module.exports = {
  extends: path.resolve(__dirname, '../../electron-builder.yml'),
  forceCodeSigning: false,
  win: {
    // Keep resource editing (icon/version metadata) and updater verification.
    // This override belongs only to an explicitly requested unsigned build.
    signExecutable: false,
    signtoolOptions: { publisherName: null },
  },
}
