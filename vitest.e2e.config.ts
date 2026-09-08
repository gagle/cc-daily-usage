import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.spec.ts"],
    globals: true,
    restoreMocks: true,
    mockReset: true,
    unstubGlobals: true,
    unstubEnvs: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: { enabled: false },
  },
});
