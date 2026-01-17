/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        dashboard: {
          bg: '#1a1a2e',
          card: '#16213e',
          accent: '#0f3460',
          highlight: '#e94560',
          text: '#eaeaea',
          muted: '#a0a0a0',
        },
      },
    },
  },
  plugins: [],
}
