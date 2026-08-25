import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: { outDir: '../../dist/renderer', emptyOutDir: true, sourcemap: true },
});
