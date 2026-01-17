/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        figma: {
          bg: '#1E1E1E',
          panel: '#2C2C2C',
          border: '#444444',
          hover: '#3C3C3C',
          accent: '#0D99FF',
          text: '#FFFFFF',
          'text-secondary': '#999999',
        },
      },
    },
  },
  plugins: [],
}
