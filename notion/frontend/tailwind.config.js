/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        notion: {
          background: '#ffffff',
          'background-secondary': '#f7f6f3',
          text: '#37352f',
          'text-secondary': '#9b9a97',
          border: '#e9e9e7',
          hover: '#efefef',
          accent: '#2eaadc',
          red: '#e03e3e',
          orange: '#d9730d',
          yellow: '#dfab01',
          green: '#0f7b6c',
          blue: '#0b6e99',
          purple: '#6940a5',
          pink: '#ad1a72',
          brown: '#64473a',
          gray: '#9b9a97',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'monospace'],
      },
    },
  },
  plugins: [],
}
