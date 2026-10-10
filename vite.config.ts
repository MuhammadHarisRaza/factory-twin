import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // three.js alone is ~600 kB; the scene is already split into its own lazy chunk.
  build: { chunkSizeWarningLimit: 1000 },
});
