import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// `npm run dev` serves the client on :5173 and forwards API/WebSocket traffic to the server on :3000.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  test: { root: import.meta.dirname, include: ['test/**/*.test.ts'], testTimeout: 30_000, fileParallelism: false },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
