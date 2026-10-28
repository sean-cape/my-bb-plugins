import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "bb-plugin-agent-graph",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
