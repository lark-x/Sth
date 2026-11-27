import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const apiOrigin = new URL(process.env.STH_DEV_API_ORIGIN || 'http://127.0.0.1:9321').origin;

export default defineConfig({
  root: fileURLToPath(new URL('./web/', import.meta.url)),
  publicDir: false,
  plugins: [vue()],
  resolve: {
    alias: { '/frontend': fileURLToPath(new URL('./frontend/', import.meta.url)) },
  },
  server: {
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request, incoming) => {
            // Preserve the backend's same-origin check when using Vite locally.
            if (incoming.headers.origin === `http://${incoming.headers.host}`) request.setHeader('Origin', apiOrigin);
          });
        },
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./frontend/dist/', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'vue',
    target: 'es2022',
  },
});
