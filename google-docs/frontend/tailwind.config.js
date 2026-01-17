/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'docs-blue': '#1a73e8',
        'docs-blue-dark': '#1557b0',
        'docs-gray': '#5f6368',
        'docs-border': '#dadce0',
        'docs-bg': '#f8f9fa',
      },
    },
  },
  plugins: [],
}
