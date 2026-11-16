import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the sources of the workspace packages, not their build output.
    alias: {
      "@pq402/core": src("core"),
      "@pq402/scheme-qorechain": src("scheme-qorechain"),
      "@pq402/server": src("server"),
      "@pq402/client": src("client"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
