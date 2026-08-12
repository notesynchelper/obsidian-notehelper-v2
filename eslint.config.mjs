import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        window: "readonly",
        document: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Image: "readonly",
        URL: "readonly",
        Blob: "readonly",
        TextDecoder: "readonly",
        process: "readonly",
        console: "readonly",
        createDiv: "readonly",
      },
    },
  },
  {
    ignores: ["src/__tests__/**", "src/__mocks__/**"],
  },
]);
