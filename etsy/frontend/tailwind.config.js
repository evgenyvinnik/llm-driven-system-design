/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#fef5f3',
          100: '#feeae4',
          200: '#fdd9ce',
          300: '#fbc0ab',
          400: '#f79b7a',
          500: '#f15a24',
          600: '#e04216',
          700: '#bc3412',
          800: '#9a2e14',
          900: '#802b17',
          950: '#451306',
        },
        secondary: {
          50: '#f6f5f4',
          100: '#e7e5e2',
          200: '#d0ccc6',
          300: '#b4ada3',
          400: '#968b7e',
          500: '#7a6f61',
          600: '#655b4f',
          700: '#534b42',
          800: '#453f38',
          900: '#3b3631',
          950: '#211e1a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Playfair Display', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
