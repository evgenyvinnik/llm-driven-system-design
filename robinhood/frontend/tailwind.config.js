/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        robinhood: {
          green: '#00C805',
          red: '#FF5000',
          dark: '#1E2124',
          darker: '#141518',
          gray: {
            100: '#F5F8FA',
            200: '#E3E5E8',
            300: '#C8CBCE',
            400: '#9DA0A5',
            500: '#6F7378',
            600: '#464A4E',
            700: '#2D3033',
            800: '#1E2124',
            900: '#141518',
          }
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
