import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", ".claude/**", "playwright-report/**", "test-results/**", "supabase/functions/**", "supabase/.temp/**"] },
  // Server, scripts and tests (TypeScript / ES modules on Node).
  {
    files: ["lib/**/*.ts", "scripts/**/*.{ts,mjs}", "tests/**/*.ts", "*.config.ts", "*.config.js"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  // Browser app: classic scripts sharing one global scope (see index.html for the
  // load order), so cross-file globals are expected and no-undef is off.
  {
    files: ["js/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: "script",
      ecmaVersion: 2022,
      globals: { ...globals.browser, supabase: "readonly", Twilio: "readonly" },
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-redeclare": "off",
    },
  },
  {
    files: ["tests/**/*.cjs"],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "no-empty": "off" },
  },
);
