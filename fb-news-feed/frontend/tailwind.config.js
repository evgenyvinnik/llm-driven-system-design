/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eff6ff',
          100: '#dbeafe',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
        facebook: {
          blue: '#1877f2',
          lightBlue: '#e7f3ff',
          gray: '#f0f2f5',
          darkGray: '#65676b',
          text: '#050505',
        },
      },
    },
  },
  plugins: [],
}
