/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'docusign-blue': '#2563eb',
        'docusign-dark': '#1e40af',
      }
    },
  },
  plugins: [],
}
