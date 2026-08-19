/** @type {import('tailwindcss').Config} */
import typography from '@tailwindcss/typography'

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: 'rgb(var(--color-paper-rgb) / <alpha-value>)',
        'paper-2': 'rgb(var(--color-paper-2-rgb) / <alpha-value>)',
        'paper-dark': 'rgb(var(--color-paper-dark-rgb) / <alpha-value>)',
        ink: 'rgb(var(--color-ink-rgb) / <alpha-value>)',
        'ink-soft': 'rgb(var(--color-ink-soft-rgb) / <alpha-value>)',
        'ink-fade': 'rgb(var(--color-ink-fade-rgb) / <alpha-value>)',
        'ink-ghost': 'rgb(var(--color-ink-ghost-rgb) / <alpha-value>)',
        skel: 'rgb(var(--color-skel-rgb) / <alpha-value>)',
        'skel-2': 'rgb(var(--color-skel-2-rgb) / <alpha-value>)',
        ember: 'rgb(var(--color-ember-rgb) / <alpha-value>)',
        'ember-soft': 'rgb(var(--color-ember-rgb) / 0.18)',
        'ember-line': 'rgb(var(--color-ember-rgb) / 0.55)',
        'ember-glow': 'rgb(var(--color-ember-rgb) / 0.10)',
        cyan: 'rgb(var(--color-cyan-rgb) / <alpha-value>)',
        'cyan-soft': 'rgb(var(--color-cyan-rgb) / 0.14)',
        neutral: {
          50: 'rgb(var(--color-neutral-50-rgb) / <alpha-value>)',
          100: 'rgb(var(--color-neutral-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--color-neutral-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--color-neutral-300-rgb) / <alpha-value>)',
          400: 'rgb(var(--color-neutral-400-rgb) / <alpha-value>)',
          500: 'rgb(var(--color-neutral-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--color-neutral-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--color-neutral-700-rgb) / <alpha-value>)',
          800: 'rgb(var(--color-neutral-800-rgb) / <alpha-value>)',
          900: 'rgb(var(--color-neutral-900-rgb) / <alpha-value>)',
        },
      },
      fontFamily: {
        hand: ['"Caveat"', '"Kalam"', 'cursive'],
        print: ['"Architects Daughter"', '"Kalam"', 'cursive'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        display: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        sans: ['"Inter"', '"PingFang SC"', '"Microsoft YaHei"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
      },
      borderRadius: {
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
        pill: 'var(--radius-pill)',
      },
    },
  },
  plugins: [typography],
}
