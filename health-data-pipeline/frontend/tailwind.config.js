/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        health: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
        },
        vitals: {
          heart: '#ef4444',
          steps: '#3b82f6',
          sleep: '#8b5cf6',
          weight: '#f59e0b',
          oxygen: '#06b6d4',
          calories: '#f97316',
        }
      }
    },
  },
  plugins: [],
}
