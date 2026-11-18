import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false }, // extension pages run in Chrome only
    rollupOptions: {
      input: {
        devtools: 'devtools.html',
        panel: 'panel.html',
      },
    },
  },
});
