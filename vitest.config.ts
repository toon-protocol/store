import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // src/**/*.test.ts is this app's own suite; deploy/*.test.ts is the
    // guard over the deploy bundle it never otherwise touches -- notably
    // deploy/auto-apply.test.ts (TOON_Network#164).
    // .sandcastle/*.test.ts guards the AFK factory against drifting from ci.yml.
    include: ['src/**/*.test.ts', 'deploy/*.test.ts', '.sandcastle/*.test.ts'],
  },
});
