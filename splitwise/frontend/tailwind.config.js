/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        split: {
          green: '#1CC29F',       // brand / "you are owed"
          'green-dark': '#0F9D82',
          teal: '#16A2B8',
          ink: '#2B3B4E',         // headings, dark UI
          'ink-soft': '#5B6B7B',
          owe: '#FF7052',         // "you owe"
          'owe-dark': '#E8542F',
          bg: '#F3F6F7',
          card: '#FFFFFF',
          line: '#E6ECEE',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
