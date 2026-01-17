/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        search: {
          blue: '#1a73e8',
          blueHover: '#1557b0',
          gray: '#5f6368',
          lightGray: '#f8f9fa',
          border: '#dfe1e5',
        },
      },
      fontFamily: {
        sans: ['Arial', 'Helvetica', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
