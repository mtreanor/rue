import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend dev server proxies /api to the Express backend (server/index.js).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api': 'http://localhost:5174',
    },
  },
  preview: {
    proxy: {
      '/api': 'http://localhost:5174',
    },
  },
});
