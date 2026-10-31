import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Vendor LLM SDKs may only be imported inside packages/llm-gateway (CLAUDE.md rule 3).
const VENDOR_SDKS = [
  "@anthropic-ai/sdk",
  "openai",
  "@google/generative-ai",
  "@google/genai",
  "cohere-ai",
  "voyageai",
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/google",
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/.next/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-console": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: VENDOR_SDKS.map((name) => ({
            name,
            message: "Vendor SDKs are only allowed in packages/llm-gateway.",
          })),
        },
      ],
    },
  },
  {
    files: ["packages/llm-gateway/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // React 19 injects no global React; DOM globals come from TypeScript's lib for .tsx.
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      "no-undef": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  {
    files: ["**/scripts/**", "**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: { "no-console": "off" },
  },
);
