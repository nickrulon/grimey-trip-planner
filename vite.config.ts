import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    // Overridable so a second dev instance can run beside the main one
    // (e.g. WEB_PORT=5279 API_PORT=5281 npm run dev).
    port: Number(process.env.WEB_PORT || 5179),
    proxy: {
      '/api': `http://localhost:${process.env.API_PORT || 5181}`,
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
