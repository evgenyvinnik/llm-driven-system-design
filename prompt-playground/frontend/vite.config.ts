import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: { '@': fromRoot('./src') },
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    port: 5173,
    proxy: {
      // SSE streams pass through the proxy unbuffered.
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
})
