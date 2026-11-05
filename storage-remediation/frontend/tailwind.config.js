/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Sequential blue ramp from the data-viz reference palette; doubles as the UI accent.
        accent: {
          50: '#eef5fd',
          100: '#cde2fb',
          200: '#9ec5f4',
          300: '#6da7ec',
          500: '#3987e5',
          600: '#2a78d6',
          700: '#256abf',
          800: '#1c5cab',
        },
        // Fixed status palette: always paired with an icon and a label, never a series color.
        status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
        // Categorical slots 1-3 (validated all-pairs) for evidence classes.
        series: { 1: '#2a78d6', 2: '#eb6834', 3: '#1baf7a' },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      keyframes: {
        flash: { '0%': { backgroundColor: 'rgb(205 226 251)' }, '100%': { backgroundColor: 'transparent' } },
        pulseDot: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
      },
      animation: { flash: 'flash 2s ease-out', pulseDot: 'pulseDot 1.6s ease-in-out infinite' },
    },
  },
  plugins: [],
}
