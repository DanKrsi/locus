import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { libraryFixes } from './vite.fixes';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), libraryFixes()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 4000,
  },
});
