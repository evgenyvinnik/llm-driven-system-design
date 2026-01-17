/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        discord: {
          dark: '#202225',
          darker: '#18191c',
          sidebar: '#2f3136',
          channel: '#36393f',
          input: '#40444b',
          hover: '#3a3c43',
          selected: '#42464d',
          text: '#dcddde',
          muted: '#72767d',
          link: '#00aff4',
          online: '#43b581',
          idle: '#faa61a',
          dnd: '#f04747',
          offline: '#747f8d',
        },
      },
    },
  },
  plugins: [],
}
