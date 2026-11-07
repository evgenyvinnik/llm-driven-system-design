import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))
const target = process.env.API_TARGET ?? 'http://localhost:3000'

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
      // The console API and the public API both live on the gateway. SSE passes through unbuffered.
      '/api': { target, changeOrigin: true },
      '/v1': { target, changeOrigin: true },
    },
  },
})
