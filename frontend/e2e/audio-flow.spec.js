// PILNAS audio→DOCX E2E testas (Playwright).
//
// Skirtingai nuo protocol-flow.spec.js (prasideda nuo įklijuoto teksto), ŠIS dengia
// VISĄ srautą nuo audio failo:
//   įkelti WAV → "Transkribuoti automatiškai" → 202 jobId → polling →
//   transkripcija atsiranda → "Generuoti protokolą" → DOCX download
//
// Tai patikrina būtent tai, ko trūko: failo upload, multipart, transcribe-jobs,
// polling, progreso rodymas, transkripcijos perkėlimas į formą.
//
// Provideriai MOCK (žr. playwright.config.js) - transkribavimas grąžina fiksuotą
// tekstą, tad testas deterministinis be tikro Whisper/GPU.

import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Sugeneruojam trumpą testinį WAV prieš testus (ffmpeg). Jei ffmpeg nėra,
// naudojam iš anksto paruoštą baitų WAV (minimalus validus PCM WAV header).
const WAV_PATH = path.join(__dirname, "fixtures", "test-audio.wav");

test.beforeAll(() => {
  const dir = path.dirname(WAV_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(WAV_PATH)) {
    try {
      execSync(`ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 "${WAV_PATH}" -y`, { stdio: "ignore" });
    } catch {
      // Fallback: minimalus validus WAV (44 baitų header + tyla), jei ffmpeg nėra.
      const header = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
        0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
        0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
        0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
      ]);
      fs.writeFileSync(WAV_PATH, header);
    }
  }
});

test.describe("Stenograma - pilnas audio→DOCX srautas", () => {
  test("įkelti WAV → transkribuoti (polling) → generuoti protokolą → DOCX", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Backend'as.*nepasiekiamas/)).not.toBeVisible();

    // 1. Režimas "Įkelti failą".
    await page.getByRole("button", { name: /Įkelti failą/ }).click();

    // 2. Pasirinkti WAV failą (paslėptas input per label).
    await page.setInputFiles('input[type="file"]', WAV_PATH);

    // 3. "Transkribuoti automatiškai" - paleidžia async transcribe-jobs + polling.
    await page.getByRole("button", { name: /Transkribuoti automatiškai/ }).click();

    // 4. Palaukti, kol transkripcija atsiranda textarea (mock provideris grąžina
    //    fiksuotą tekstą po polling ciklo). Tai patikrina 202→polling→completed→forma.
    const transcriptArea = page.getByPlaceholder(/Transkripcija/);
    await expect(transcriptArea).not.toHaveValue("", { timeout: 30_000 });

    // 5. Pavadinimas (kad protokolas turėtų kontekstą).
    await page.getByPlaceholder("Susitikimo pavadinimas").fill("Audio testas");

    // 6. Generuoti protokolą.
    await page.getByRole("button", { name: "Generuoti protokolą" }).click();
    await expect(page.getByText("Dokumentas dar neparengtas")).not.toBeVisible({ timeout: 30_000 });

    // 7. Eksportuoti DOCX.
    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByRole("button", { name: "Word (.docx)" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.docx$/);
  });

  test("netinkamas failo formatas atmetamas (backend validacija)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Įkelti failą/ }).click();

    // Sukuriam netikrą .wav (tekstinis turinys, ne audio) - backend magic-bytes
    // validacija turi atmesti.
    const fakeWav = path.join(__dirname, "fixtures", "fake.wav");
    fs.writeFileSync(fakeWav, "tai ne audio, o paprastas tekstas");
    await page.setInputFiles('input[type="file"]', fakeWav);
    await page.getByRole("button", { name: /Transkribuoti automatiškai/ }).click();

    // Turi pasirodyti klaida (ne transkripcija). Transkripcijos laukas lieka tuščias.
    await expect(page.getByText(/nepavyko|klaida|formatas/i)).toBeVisible({ timeout: 30_000 });
  });

  test("kai backend nepasiekiamas paleidimo metu, rodomas aiškus pranešimas", async ({ page }) => {
    // Frontend "online" statusą lemia /api/ready (readiness patikra komponento paleidimo
    // metu). Blokuojam būtent jį - tiksliau nei visą /api/**, ir aiškiai patikrina readiness
    // priklausomybę. page.route PRIEŠ page.goto - kad blokavimas veiktų nuo pirmos užklausos.
    // PASTABA: tikrina STARTINĘ būseną (backend offline paleidimo metu), ne ryšio praradimą
    // jau atidarytame lange - App.jsx nedaro periodinės health patikros (žr. DEPLOYMENT).
    await page.route("**/api/ready", (route) => route.abort("connectionfailed"));
    await page.goto("/");

    // Tikrinam raudoną klaidos pranešimą per role="alert" - semantiška ir TIKSLU (regex
    // /backend.*nepasiekiamas/ pagautų DU elementus: statuso žymą IR šį pranešimą ->
    // Playwright strict mode violation. role="alert" nurodo būtent klaidos juostą.).
    await expect(page.getByRole("alert")).toContainText(/backend.*nepasiekiamas/i, { timeout: 15_000 });
  });
});
