import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

export function validateReleasePolicy(value, version) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || value.schemaVersion !== 1 || !SEMVER.test(String(version || ''))
    || value.version !== version || !['signed', 'unsigned'].includes(value.windowsSigning)
    || Object.keys(value).some(key => !['schemaVersion', 'version', 'windowsSigning'].includes(key))) {
    throw new Error('Release policy must explicitly declare signed or unsigned for the exact package version')
  }
  return Object.freeze({ schemaVersion: 1, version, windowsSigning: value.windowsSigning })
}

export function readReleasePolicy(rootDir = ROOT) {
  const metadata = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
  const policy = JSON.parse(fs.readFileSync(path.join(rootDir, 'scripts/release/policy.json'), 'utf8'))
  return validateReleasePolicy(policy, metadata.version)
}

export function assertReleaseSigningInputs(policy, env = process.env) {
  validateReleasePolicy(policy, policy.version)
  if (policy.windowsSigning === 'unsigned') return
  for (const [key, label] of [
    ['CSC_LINK', 'WINDOWS_CSC_LINK'],
    ['CSC_KEY_PASSWORD', 'WINDOWS_CSC_KEY_PASSWORD'],
    ['WINDOWS_PUBLISHER_NAME', 'WINDOWS_PUBLISHER_NAME'],
  ]) {
    if (typeof env[key] !== 'string' || !env[key].trim()) {
      throw new Error(`${label} is required for the declared signed release; automatic unsigned fallback is forbidden`)
    }
  }
}

export function releasePolicyNotes(policy) {
  validateReleasePolicy(policy, policy.version)
  return policy.windowsSigning === 'unsigned'
    ? '## Windows build: unsigned / Windows 安装包：未签名\n\n'
      + 'This release intentionally has no Windows Authenticode publisher signature. Windows may show an unknown-publisher or SmartScreen warning. Do not disable Windows protections; verify the official repository, checksums and GitHub build provenance before deciding to install. These checks do not substitute for a signing certificate. Correctly verifying signed clients may require a user-initiated manual migration to this unsigned build.\n\n'
      + '此版本按维护者明确选择发布未签名安装包，Windows 可能提示未知发布者。请核验官方仓库、校验和及构建来源，不要关闭系统保护；这些检查不等价于代码签名。正确验签的已签名客户端可能需要用户主动手动迁移。'
    : '## Windows build: signed / Windows 安装包：已签名\n\n'
      + 'The release workflow requires valid timestamped Authenticode signatures and the configured publisher identity on both the installer and application. Verify SHA256SUMS.txt and GitHub build provenance as well.\n\n'
      + '发布工作流要求安装包与主程序具有有效时间戳签名，且发布者匹配配置；仍应同时核验校验和与构建来源。'
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--github-output' || !args[1])) {
      throw new Error('Usage: node scripts/release/releasePolicy.mjs [--github-output FILE]')
    }
    const policy = readReleasePolicy()
    assertReleaseSigningInputs(policy)
    if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${policy.version}`) {
      throw new Error('Release tag does not match the version-bound release policy')
    }
    if (args.length) fs.appendFileSync(args[1], `windows_signing=${policy.windowsSigning}\n`, 'utf8')
    console.log(`Release ${policy.version}: explicit Windows signing policy = ${policy.windowsSigning}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
