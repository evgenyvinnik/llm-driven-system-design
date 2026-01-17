/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'apple-red': '#FA243C',
        'apple-pink': '#FC5C7D',
        'apple-bg': '#000000',
        'apple-card': '#1C1C1E',
        'apple-border': '#38383A',
        'apple-text': '#FFFFFF',
        'apple-text-secondary': '#8E8E93',
      },
    },
  },
  plugins: [],
}
