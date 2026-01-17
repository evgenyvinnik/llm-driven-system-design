/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'spotify-green': '#1DB954',
        'spotify-green-dark': '#1aa34a',
        'spotify-black': '#121212',
        'spotify-dark-gray': '#181818',
        'spotify-light-gray': '#282828',
        'spotify-text': '#B3B3B3',
        'spotify-hover': '#2a2a2a',
      },
    },
  },
  plugins: [],
}
