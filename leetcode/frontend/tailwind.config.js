/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#fef7ec',
          100: '#fcecd3',
          200: '#f9d5a6',
          300: '#f5b86e',
          400: '#f09235',
          500: '#ec7211', // LeetCode orange
          600: '#d85a0c',
          700: '#b4420d',
          800: '#923512',
          900: '#782e12',
        },
        dark: {
          100: '#3e3e3e',
          200: '#2a2a2a',
          300: '#1e1e1e',
          400: '#161616',
          500: '#0a0a0a',
        }
      }
    },
  },
  plugins: [],
}
