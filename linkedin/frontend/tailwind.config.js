/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        linkedin: {
          blue: '#0a66c2',
          'blue-dark': '#004182',
          'blue-light': '#70b5f9',
          gray: '#f3f2ef',
          'gray-dark': '#38434f',
          green: '#057642',
        },
      },
    },
  },
  plugins: [],
}
