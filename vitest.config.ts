import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts", "evals/**/*.test.ts"],
    environment: "node",
  },
});
