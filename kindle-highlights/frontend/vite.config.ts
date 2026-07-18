import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-vite-plugin'
import path from 'path'

export default defineConfig({
  plugins: [react(), TanStackRouterVite()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    port: 5173,
    proxy: {
      // Microservices with no gateway: route each path to its owning service.
      // social (3001) owns /api/auth, users, followers, settings, and most reads;
      // highlight (3000) owns library/export; aggregation (3003) owns trending.
      '/api/library': { target: 'http://localhost:3000', changeOrigin: true },
      '/api/export': { target: 'http://localhost:3000', changeOrigin: true },
      '/api/trending': { target: 'http://localhost:3003', changeOrigin: true },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
