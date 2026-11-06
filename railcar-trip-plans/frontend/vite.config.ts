import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))

// Defaults follow the repo's port conventions; override with VITE_PORT / API_URL.
const port = Number(process.env.VITE_PORT || 5173)
const apiTarget = process.env.API_URL || 'http://localhost:3000'

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: { '@': fromRoot('./src') },
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    port,
    strictPort: true,
    proxy: {
      // The SSE live-update stream passes through the proxy unbuffered.
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
})
