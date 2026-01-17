/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        slack: {
          purple: '#4A154B',
          'purple-dark': '#350d36',
          'purple-light': '#611f69',
          green: '#2BAC76',
          blue: '#1264A3',
          red: '#E01E5A',
          yellow: '#ECB22E',
          sidebar: '#3F0E40',
          'sidebar-active': '#1164A3',
          'sidebar-hover': 'rgba(255,255,255,0.06)',
          'message-hover': 'rgba(29,28,29,0.04)',
        },
      },
      fontFamily: {
        slack: ['Slack-Lato', 'Lato', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
