/** @type {import('tailwindcss').Config} */
// Neutral surfaces are CSS variables (see index.css), so the user's theme setting
// swaps them in one place instead of a dark: variant on every element.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        page: v('page'),
        surface: v('surface'),
        sunken: v('sunken'),
        line: v('line'),
        ink: v('ink'),
        muted: v('muted'),
        faint: v('faint'),
        accent: {
          50: '#eef2ff',
          100: '#e0e7ff',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        flash: { '0%': { backgroundColor: 'rgb(99 102 241 / 0.18)' }, '100%': { backgroundColor: 'transparent' } },
      },
      animation: { flash: 'flash 2s ease-out' },
    },
  },
  plugins: [],
}
