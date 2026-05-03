import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, forward /api/* to the Flask backend so the frontend can use the
// same `/api/...` URLs in dev and prod (where it talks to the same origin
// or VITE_API_URL).
const BACKEND_URL = process.env.VITE_DEV_BACKEND_URL || 'http://localhost:5001'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        // SSE: don't buffer the response; let chunks flow through.
        ws: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: ['.railway.app']
  }
})