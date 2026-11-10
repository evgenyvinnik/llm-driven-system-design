/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#fdf6ec', 100: '#f9e8cf', 500: '#c2772f', 600: '#a8621f', 700: '#874c17', 900: '#3d230b' },
      },
      fontFamily: {
        display: ['Georgia', 'ui-serif', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
