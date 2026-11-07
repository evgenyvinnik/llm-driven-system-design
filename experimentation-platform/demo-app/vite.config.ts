import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { fileURLToPath } from 'node:url'

const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url))

// The demo storefront: a customer's app that embeds the SDK. It talks to api-b
// (3001) by default while the console talks to api-a (3000), so every change and
// kill switch reaches this page through Valkey pub/sub between instances.
export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: {
      '@': fromRoot('./src'),
      'experimentation-sdk/react': fromRoot('../sdk/src/react/index.ts'),
      'experimentation-sdk': fromRoot('../sdk/src/index.ts'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    port: Number(process.env.VITE_PORT ?? 5180),
    strictPort: true,
    fs: { allow: [fromRoot('..')] },
    proxy: {
      '/api': { target: process.env.API_TARGET ?? 'http://localhost:3001', changeOrigin: true },
      '/sdk': { target: process.env.API_TARGET ?? 'http://localhost:3001', changeOrigin: true },
    },
  },
})
