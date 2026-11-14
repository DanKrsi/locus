// Builds the viewer that ships inside an exported folder: one JavaScript file and one stylesheet,
// with no module loading, so a page opened from a disk (file://) runs it without a server.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/viewer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/viewer',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 8000,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'viewer.js',
        assetFileNames: 'viewer[extname]',
      },
    },
  },
});
