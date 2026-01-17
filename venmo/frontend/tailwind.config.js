/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        venmo: {
          blue: '#008CFF',
          'dark-blue': '#0074D4',
          light: '#F5F9FC',
        },
      },
    },
  },
  plugins: [],
}
