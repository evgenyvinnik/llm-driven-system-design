/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))

// API_PROXY_TARGET moves the backend off 3000 when another project already holds it.
const apiProxy = {
  // SSE streams pass through the proxy unbuffered.
  '/api': { target: process.env.API_PROXY_TARGET || 'http://localhost:3000', changeOrigin: true },
}

export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: { '@': fromRoot('./src') },
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    port: 5173,
    proxy: apiProxy,
  },
  // `vite preview` serves the production build, which registers the offline service worker.
  preview: { port: 4173, proxy: apiProxy },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
