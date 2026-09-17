import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Der Digest formatiert in Ortszeit. Ohne feste Zone haengen die
    // Erwartungen an der Zone des ausfuehrenden Rechners.
    env: { TZ: 'Europe/Zurich' },
  },
});
