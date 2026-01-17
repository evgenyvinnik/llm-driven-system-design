/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'yelp-red': '#d32323',
        'yelp-red-dark': '#af1c1c',
        'yelp-blue': '#0073bb',
      },
    },
  },
  plugins: [],
}
