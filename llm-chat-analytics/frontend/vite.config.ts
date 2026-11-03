import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))
// The API port can move when another stack holds 3000 (see README).
const apiTarget = process.env.API_TARGET || `http://localhost:${process.env.API_PORT || 3000}`

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: { '@': fromRoot('./src') },
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
})
