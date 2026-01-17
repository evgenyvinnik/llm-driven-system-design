/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        reddit: {
          orange: '#ff4500',
          orangeDark: '#d93a00',
          blue: '#0079d3',
          lightGray: '#dae0e6',
          darkGray: '#1a1a1b',
          cardBg: '#ffffff',
          border: '#ccc',
        },
      },
    },
  },
  plugins: [],
}
