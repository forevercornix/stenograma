import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    environment: "jsdom",
    globals: true,
    // Vitest ima TIK vieneto testus (src/). e2e/ yra Playwright specai (kiti API:
    // test.describe/beforeAll), kuriuos vitest bandė paleisti ir krito
    // ("Playwright Test did not expect test.describe()"). Playwright juos leidžia
    // atskirai (npm run test:e2e).
    include: ["src/**/*.{test,spec}.{js,jsx,ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
