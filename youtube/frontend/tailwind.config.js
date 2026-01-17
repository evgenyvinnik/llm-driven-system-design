/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'yt-red': '#FF0000',
        'yt-dark': '#0f0f0f',
        'yt-dark-lighter': '#181818',
        'yt-dark-hover': '#272727',
        'yt-gray': '#aaaaaa',
        'yt-blue': '#3ea6ff',
      },
    },
  },
  plugins: [],
}
