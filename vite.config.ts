import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5000, strictPort: true },
  preview: { port: 5000 },
  build: {
    target: 'es2020',
    // Vite 8 bundles with Rolldown: object-form manualChunks is gone, use codeSplitting groups.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'firebase', test: /[\\/]node_modules[\\/](firebase|@firebase)[\\/]/ },
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
