import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The real vLLM inference server exposes Prometheus text at
// http://192.168.0.104:18982/metrics. The app fetches the relative path
// /metrics by default; this proxy keeps the dev server CORS-free.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/metrics': {
        target: 'http://192.168.0.104:18982/metrics',
        changeOrigin: true,
      },
      // auths sidecar (local dev) — all /api/* auth endpoints. In dev the
      // frontend is static; the login/API calls hit this proxy directly.
      '/api': {
        target: 'http://127.0.0.1:9341',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/metrics': {
        target: 'http://192.168.0.104:18982/metrics',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:9341',
        changeOrigin: true,
      },
    },
  },
})
