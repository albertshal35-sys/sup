import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: the tests exercise the Worker,
// which has no React and no JSX, so loading the app's plugins would only add
// transform cost and noise.
export default defineConfig({
  test: {
    include: ["worker/test/**/*.test.ts"],
    environment: "node",
  },
});
