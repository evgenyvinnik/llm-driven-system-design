import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import { fileURLToPath } from 'node:url';

// The package is ESM ("type": "module"), so there is no __dirname; resolve from this file's URL
const fromRoot = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [TanStackRouterVite(), react()],
  resolve: {
    alias: {
      '@': fromRoot('./src'),
    },
  },
  server: {
    allowedHosts: ['host.docker.internal'],
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fromRoot('./index.html'),
        sw: fromRoot('./src/sw.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Output service worker at root level
          if (chunkInfo.name === 'sw') {
            return 'sw.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
