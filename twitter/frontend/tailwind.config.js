/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        twitter: {
          blue: '#1DA1F2',
          dark: '#14171A',
          gray: '#657786',
          lightGray: '#AAB8C2',
          extraLightGray: '#E1E8ED',
          background: '#F5F8FA',
        },
      },
    },
  },
  plugins: [],
};
