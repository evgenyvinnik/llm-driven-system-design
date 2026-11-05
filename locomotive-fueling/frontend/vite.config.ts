import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))

// VITE_PORT and API_TARGET let several projects run side by side; defaults follow the repo conventions.
export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: { '@': fromRoot('./src') },
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: {
      // SSE (/api/v1/events) passes through the proxy unbuffered.
      '/api': { target: process.env.API_TARGET ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
})
