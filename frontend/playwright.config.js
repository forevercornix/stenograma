// Playwright E2E konfigūracija.
//
// Testai paleidžia TIKRĄ backend'ą (mock provideriais - be raktų/GPU) ir frontend
// dev serverį, tada per naršyklę atlieka pilną vartotojo srautą.
//
// Paleidimas:
//   npm run test:e2e            (headless, CI režimas)
//   npm run test:e2e:headed     (matomas naršyklės langas, debug)
//
// ⚠️ Reikia įdiegtų naršyklių: npx playwright install chromium
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Vienas darbininkas - testai dalinasi backend būsena (job store atmintyje).
  workers: 1,
  fullyParallel: false,
  timeout: 60_000, // transkribavimas+generavimas gali užtrukti
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "list" : "html",

  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  // Playwright PATS paleidžia backend (mock) ir frontend prieš testus ir sustabdo po.
  // Mock provideriai - jokių API raktų, GPU ar tinklo; viskas lokaliai ir determ.
  webServer: [
    {
      command: "cd ../backend && LLM_PROVIDER=mock TRANSCRIPTION_PROVIDER=mock DIARIZATION_PROVIDER=none npm start",
      url: "http://localhost:3001/api/ready",
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev -- --port 5173",
      url: "http://localhost:5173",
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
      // Frontend dev režimu naudoja localhost:3001 (VITE_BACKEND_URL numatytas dev).
    },
  ],
});
