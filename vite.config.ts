import { fileURLToPath } from 'node:url';
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import { devApiPlugin } from './src/web/server/dev-api-plugin.js';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The web UI is a small dev/observability client. Its sources live under src/web,
  // but it imports pure modules from src/core, so the fs allow-list covers the repo.
  root: path.resolve(projectRoot, 'src/web'),
  plugins: [tailwindcss(), devApiPlugin({ projectRoot })],
  server: {
    port: 5173,
    fs: {
      allow: [projectRoot],
    },
  },
  build: {
    outDir: path.resolve(projectRoot, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
