import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    hmr: false
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
