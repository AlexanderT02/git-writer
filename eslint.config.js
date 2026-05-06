import eslint from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["src/**/*.ts"],
    plugins: {
      "@stylistic": stylistic,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-this-alias": "off",

      "no-console": "off",

      "@stylistic/indent": ["error", 2],
      "@stylistic/quotes": ["error", "double"],
      "@stylistic/semi": ["error", "always"],
      "@stylistic/comma-dangle": ["error", "always-multiline"],
      "@stylistic/object-curly-spacing": ["error", "always"],
      "@stylistic/array-bracket-spacing": ["error", "never"],
      "@stylistic/space-before-function-paren": [
        "error",
        {
          anonymous: "always",
          named: "never",
          asyncArrow: "always",
        },
      ],
      "@stylistic/keyword-spacing": "error",
      "@stylistic/space-infix-ops": "error",
      "@stylistic/eol-last": ["error", "always"],
      "@stylistic/no-multiple-empty-lines": [
        "error",
        {
          max: 1,
          maxEOF: 0,
        },
      ],
      "@stylistic/padded-blocks": ["error", "never"],
      "@stylistic/brace-style": ["error", "1tbs"],
    },
  },
);