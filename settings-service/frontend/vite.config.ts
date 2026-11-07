import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))

const apiA = process.env.API_TARGET ?? 'http://localhost:3000'
const apiB = process.env.API_TARGET_B ?? 'http://localhost:3001'

// VITE_PORT, API_TARGET and API_TARGET_B let several projects run side by side; defaults follow the repo conventions.
// /api goes to instance A; /api-b goes to instance B, so the two-devices view can put one "device" on each
// instance and show a write on A arriving over SSE on B.
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
      '/api-b': { target: apiB, changeOrigin: true, rewrite: (path) => path.replace(/^\/api-b/, '/api') },
      '/api': { target: apiA, changeOrigin: true },
    },
  },
})
