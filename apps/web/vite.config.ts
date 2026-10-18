import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The API server the dev server and the preview proxy to (same origin for the session cookie). */
const api = process.env['KOSH_API'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['@kosh/source'] },
  server: { proxy: { '/api': api } },
  preview: { proxy: { '/api': api } },
  build: { chunkSizeWarningLimit: 900 },
});
