/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        imessage: {
          blue: '#007AFF',
          green: '#34C759',
          gray: '#8E8E93',
          lightGray: '#F2F2F7',
          darkGray: '#1C1C1E',
        },
      },
    },
  },
  plugins: [],
}
