/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        kindle: {
          cream: '#faf8f5',
          sepia: '#f4ecd8',
          yellow: '#fff59d',
          orange: '#ffab91',
          blue: '#90caf9',
          green: '#a5d6a7',
          pink: '#f48fb1',
        },
      },
      fontFamily: {
        serif: ['Georgia', 'Cambria', 'serif'],
      },
    },
  },
  plugins: [],
}
