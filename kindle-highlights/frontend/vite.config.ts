import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-vite-plugin'
import path from 'path'

// Four backend services and no gateway: the dev proxy plays the API gateway and routes each
// path to the service that owns it. Override a target to point at another instance.
const services = {
  highlight: process.env.HIGHLIGHT_URL || 'http://localhost:3000',
  social: process.env.SOCIAL_URL || 'http://localhost:3001',
  sync: process.env.SYNC_URL || 'http://localhost:3002',
  aggregation: process.env.AGGREGATION_URL || 'http://localhost:3003',
}

const to = (target: string) => ({ target, changeOrigin: true })

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
    // Vite uses the FIRST matching key, so specific routes come before their prefixes.
    // Keys starting with ^ are regular expressions.
    proxy: {
      '^/api/highlights/[^/]+/share': to(services.social),
      '/api/highlights': to(services.highlight),
      '/api/library': to(services.highlight),
      '/api/export': to(services.highlight),
      '^/api/books/[^/]+/friends-highlights': to(services.social),
      '/api/books': to(services.aggregation), // popular, heatmap, count
      '/api/trending': to(services.aggregation),
      '/api/sync': { ...to(services.sync), ws: true }, // change feed, push, WebSocket
      '/api': to(services.social), // auth, users, following, followers, settings
    },
  },
})
