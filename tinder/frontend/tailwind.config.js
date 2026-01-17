/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#fef2f2',
          100: '#ffe1e1',
          200: '#ffc8c8',
          300: '#ffa1a1',
          400: '#fe6b6b',
          500: '#f73b3b',
          600: '#e41d1d',
          700: '#c01414',
          800: '#9f1515',
          900: '#841818',
        },
        gradient: {
          start: '#fd267a',
          end: '#ff6036',
        },
      },
      backgroundImage: {
        'tinder-gradient': 'linear-gradient(to right, #fd267a, #ff6036)',
      },
    },
  },
  plugins: [],
};
