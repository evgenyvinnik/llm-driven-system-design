/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        doordash: {
          red: '#FF3008',
          darkRed: '#EB1700',
          gray: {
            50: '#F7F7F7',
            100: '#EBEBEB',
            200: '#D6D6D6',
            300: '#B8B8B8',
            400: '#8F8F8F',
            500: '#6B6B6B',
            600: '#4A4A4A',
            700: '#363636',
            800: '#242424',
            900: '#191919',
          },
        },
      },
    },
  },
  plugins: [],
};
