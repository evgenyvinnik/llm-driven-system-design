/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Twitch purple theme
        'twitch': {
          '50': '#f5f3ff',
          '100': '#ede9fe',
          '200': '#ddd6fe',
          '300': '#c4b5fd',
          '400': '#a78bfa',
          '500': '#9147ff',
          '600': '#7c3aed',
          '700': '#6d28d9',
          '800': '#5b21b6',
          '900': '#4c1d95',
        },
        'surface': {
          'dark': '#0e0e10',
          'darker': '#18181b',
          'light': '#1f1f23',
          'lighter': '#26262c',
        }
      },
    },
  },
  plugins: [],
}
