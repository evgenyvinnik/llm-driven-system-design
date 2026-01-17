/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'apple-black': '#000000',
        'apple-gray': {
          100: '#F5F5F7',
          200: '#E8E8ED',
          300: '#D2D2D7',
          400: '#86868B',
          500: '#6E6E73',
          600: '#424245',
          700: '#2D2D30',
          800: '#1D1D1F',
          900: '#0D0D0D',
        },
        'apple-blue': '#0071E3',
        'apple-green': '#34C759',
        'apple-red': '#FF3B30',
      },
      fontFamily: {
        sans: ['SF Pro Display', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
