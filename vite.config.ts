import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/desktop/renderer',
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src/desktop/renderer', import.meta.url)) },
  },
  worker: { format: 'es' },
  build: {
    outDir: '../../../build/dist/desktop/renderer',
    emptyOutDir: true,
    // Monaco 与 Shiki 只在打开 diff 或渲染代码块时按需加载，单个分块本来就大。
    chunkSizeWarningLimit: 4096,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
