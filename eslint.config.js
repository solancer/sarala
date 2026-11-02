import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid/configs/typescript";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "web/dist/", "web/public/", "web/wasm/", "web/src/sw.js"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}", "web/src/**/*.{ts,tsx}"],
    ...solid,
  },
);
