import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // site/ is a static page and its generated data, served as is.
    ignores: ["**/dist/**", "contracts/**", "**/node_modules/**", "**/coverage/**", "site/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", URL: "readonly" } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
