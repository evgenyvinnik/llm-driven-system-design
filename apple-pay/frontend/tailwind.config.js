/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        apple: {
          blue: '#007AFF',
          green: '#34C759',
          red: '#FF3B30',
          orange: '#FF9500',
          yellow: '#FFCC00',
          gray: {
            50: '#F9F9F9',
            100: '#F2F2F7',
            200: '#E5E5EA',
            300: '#D1D1D6',
            400: '#C7C7CC',
            500: '#8E8E93',
            600: '#636366',
            700: '#48484A',
            800: '#3A3A3C',
            900: '#1C1C1E',
          },
        },
        visa: '#1A1F71',
        mastercard: '#EB001B',
        amex: '#006FCF',
      },
      boxShadow: {
        card: '0 4px 20px rgba(0, 0, 0, 0.15)',
      },
      borderRadius: {
        card: '12px',
      },
    },
  },
  plugins: [],
};
