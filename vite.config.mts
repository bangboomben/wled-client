import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = resolve('src/renderer');

export default defineConfig(({ command }) => ({
  root,
  base: './',
  plugins: [
    react(),
    {
      // Im Dev-Server braucht React-Refresh ein Inline-Skript — dort die CSP weglassen.
      name: 'dev-without-csp',
      transformIndexHtml: (html: string) =>
        command === 'serve' ? html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '') : html,
    },
  ],
  build: {
    outDir: resolve('dist/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        flyout: resolve(root, 'flyout.html'),
      },
    },
  },
  server: { port: 5199, strictPort: true },
}));
