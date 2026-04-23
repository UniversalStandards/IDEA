import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/admin-ui/',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/admin': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    }
  }
})
