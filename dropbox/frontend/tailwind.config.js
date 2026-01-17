/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        dropbox: {
          blue: '#0061FF',
          'blue-dark': '#0052D9',
          'blue-light': '#3385FF',
        },
      },
    },
  },
  plugins: [],
}
