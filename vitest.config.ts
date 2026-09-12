import { defineConfig } from 'vitest/config';

// Unit tests cover the pure logic modules under src/lib. They need no DOM, so the
// default node environment is used. The app build (tsc -b && vite build) excludes
// *.test.ts files, so tests never ship in the packaged app.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
