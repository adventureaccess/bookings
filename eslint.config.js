import astro from "eslint-plugin-astro";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/", ".astro/", ".netlify/", "node_modules/"] },
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
];
