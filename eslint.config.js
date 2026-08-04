import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'build-*', '.build-*', '.verify-dist-*', '.verify-build-*', '.codex-*', '.artifacts', '.superpowers', '.tmp', 'plugins/**/*.js', 'public/sandbox/**/*.js']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'vite.config.js', 'tests/**/*.js', 'bin/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['server/**/*.js'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
])
