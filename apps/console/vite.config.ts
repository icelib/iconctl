import Vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/app/',
  plugins: [Vue()],
  build: { outDir: 'dist/public/app', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
})
