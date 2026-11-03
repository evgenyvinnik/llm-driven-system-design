import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))

// API_TARGET moves the proxy when another project already holds port 3000.
const apiTarget = process.env.API_TARGET || 'http://localhost:3000'

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: { '@': fromRoot('./src') },
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    port: 5173,
    proxy: {
      // The event stream passes through the proxy unbuffered.
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
})
