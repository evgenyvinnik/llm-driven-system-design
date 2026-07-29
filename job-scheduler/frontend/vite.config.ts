import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(),],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    // 5173 is the repo-wide Vite dev-server port. It must NOT be 3000: this
    // project's docker-compose publishes the built frontend container on host
    // 3000 (`3000:80`), so a dev server on 3000 collides with it, silently falls
    // back to another port, and any tooling expecting 5173 finds nothing.
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
