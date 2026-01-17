/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        whatsapp: {
          green: '#25D366',
          'dark-green': '#128C7E',
          'teal-green': '#075E54',
          blue: '#34B7F1',
          'chat-bg': '#ECE5DD',
          'message-out': '#DCF8C6',
          'message-in': '#FFFFFF',
        },
      },
    },
  },
  plugins: [],
};
