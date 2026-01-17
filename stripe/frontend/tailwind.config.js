/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        stripe: {
          purple: '#635bff',
          'purple-dark': '#5149e0',
          blue: '#00d4ff',
          green: '#00d924',
          yellow: '#ffbb00',
          red: '#ff5454',
          gray: {
            50: '#f7f8f9',
            100: '#e3e8ee',
            200: '#c4cdd5',
            300: '#9ca6b0',
            400: '#6b7680',
            500: '#4f5b66',
            600: '#3c4257',
            700: '#2a2f45',
            800: '#1a1f36',
            900: '#0a2540',
          },
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Ubuntu',
          'sans-serif',
        ],
        mono: ['SF Mono', 'Consolas', 'Liberation Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
