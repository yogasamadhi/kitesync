import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const nodePort = Number(process.env.KITESYNC_UI_PORT ?? process.env.KITESYNC_PORT ?? 3210);
if (!Number.isInteger(nodePort) || nodePort < 1 || nodePort > 65_535) {
  throw new Error('KITESYNC_UI_PORT 必须是 1 到 65535 之间的整数');
}
const nodeTarget = `http://127.0.0.1:${nodePort}`;

export function nodeProxyOptions(target = nodeTarget) {
  return {
    target,
    // Vite's string shorthand enables changeOrigin. Keeping the browser-facing Host makes
    // Origin and Host match at the Node Service while still rejecting another local origin.
    changeOrigin: false,
  };
}

export default defineConfig({
  envDir: false,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': nodeProxyOptions(),
      '/health': nodeProxyOptions(),
      '/internal': nodeProxyOptions(),
    },
  },
  build: { sourcemap: true },
});
