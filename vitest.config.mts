import { defineConfig } from 'vitest/config';

// Unit-Tests für die reine Logik (ohne Electron). Die vite.config.mts gilt nur für die Oberfläche
// (Wurzel src/renderer); Vitest nimmt diese Datei bevorzugt.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
