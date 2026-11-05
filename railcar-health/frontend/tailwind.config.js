/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          500: '#2a78d6',
          600: '#256abf',
          700: '#1c5cab',
        },
        // Reserved status colours for risk tiers; always shown with a label and icon.
        tier: {
          critical: '#d03b3b',
          high: '#ec835a',
          medium: '#fab219',
          low: '#64748b',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        flash: { '0%': { backgroundColor: 'rgb(254 243 199)' }, '100%': { backgroundColor: 'transparent' } },
      },
      animation: { flash: 'flash 2.5s ease-out' },
    },
  },
  plugins: [],
}
