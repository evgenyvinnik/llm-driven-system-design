/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        strava: {
          orange: '#FC4C02',
          'orange-dark': '#E34402',
          gray: {
            50: '#F7F7F7',
            100: '#EDEDED',
            200: '#D9D9D9',
            300: '#BFBFBF',
            400: '#999999',
            500: '#666666',
            600: '#4D4D4D',
            700: '#333333',
            800: '#1A1A1A',
            900: '#0D0D0D'
          }
        }
      }
    },
  },
  plugins: [],
}
