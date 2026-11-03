/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Chart and chrome tokens: see the CSS variables in src/index.css.
        surface: 'var(--surface-1)',
        plane: 'var(--page-plane)',
        ink: { DEFAULT: 'var(--text-primary)', 2: 'var(--text-secondary)', muted: 'var(--text-muted)' },
        line: { DEFAULT: 'var(--gridline)', strong: 'var(--baseline)' },
        series: { 1: 'var(--series-1)', 2: 'var(--series-2)', 3: 'var(--series-3)' },
        status: { good: 'var(--status-good)', warning: 'var(--status-warning)', serious: 'var(--status-serious)', critical: 'var(--status-critical)' },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
