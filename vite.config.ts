import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5179,
    proxy: {
      '/api': 'http://localhost:5181',
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
