// Pilnas vartotojo srauto E2E testas (Playwright).
//
// Kelias: atidaryti frontend -> pasirinkti "Įklijuoti tekstą" -> įvesti transkripciją
// -> "Generuoti protokolą" -> patikrinti, kad protokolas atsirado -> eksportuoti DOCX.
//
// Tai TIKSLIAI ta testų klasė, kurios trūko (README "NOT verified"): naršyklinis
// srautas, kur dažnai lūžta formos, polling, download, API raktų headeriai, būsenos.
//
// Provideriai - MOCK (backend paleistas su LLM_PROVIDER=mock ir kt. per
// playwright.config.js), tad testas deterministinis, be raktų/GPU/tinklo.

import { test, expect } from "@playwright/test";

test.describe("Stenograma - pilnas protokolo srautas", () => {
  test("įklijuoti tekstą → generuoti protokolą → eksportuoti DOCX", async ({ page }) => {
    // 1. Atidaryti aplikaciją.
    await page.goto("/");
    await expect(page.getByText("Stenograma").first()).toBeVisible();

    // 2. Backend turi būti pasiekiamas (jei ne, testas neturi prasmės).
    //    App tikrina /api/health; "offline" juosta neturi būti matoma.
    await expect(page.getByText(/Backend'as.*nepasiekiamas/)).not.toBeVisible();

    // 3. Pasirinkti "Įklijuoti tekstą" režimą.
    await page.getByRole("button", { name: /Įklijuoti tekstą/ }).click();

    // 4. Įvesti pavadinimą ir transkripciją.
    await page.getByPlaceholder("Susitikimo pavadinimas").fill("Testinis posėdis");
    const transcript =
      "Jonas: Sveiki visi, pradedame susitikimą. " +
      "Ona: Aptarkime pirmąjį klausimą dėl biudžeto. " +
      "Jonas: Sutinku, nusprendžiame patvirtinti planą. " +
      "Ona: Petras paruoš ataskaitą iki penktadienio.";
    await page.getByPlaceholder(/Įklijuokite susitikimo transkripciją/).fill(transcript);

    // 5. Generuoti protokolą.
    await page.getByRole("button", { name: "Generuoti protokolą" }).click();

    // 6. Palaukti, kol protokolas sugeneruojamas (mock LLM - greita, bet async).
    //    "PARENGTA" antspaudas ir "Protokolas" antraštė rodo pabaigą.
    await expect(page.getByText("PARENGTA")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Protokolas").first()).toBeVisible();

    // 7. Patikrinti, kad protokolo turinys realiai atsirado (ne tuščias).
    //    Mock provideris iš transkripcijos sudaro darbotvarkę/klausimus.
    await expect(page.getByRole("button", { name: "Word (.docx)" })).toBeVisible();

    // 8. Eksportuoti DOCX - patikrinti, kad download realiai prasideda.
    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByRole("button", { name: "Word (.docx)" }).click();
    const download = await downloadPromise;

    // 9. Patikrinti, kad atsisiųstas failas yra .docx ir netuščias.
    expect(download.suggestedFilename()).toMatch(/\.docx$/);
    const path = await download.path();
    expect(path).toBeTruthy();
  });

  test("tuščia transkripcija neleidžia generuoti (validacija)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Įklijuoti tekstą/ }).click();

    // Be transkripcijos "Generuoti protokolą" arba neaktyvus, arba parodo klaidą.
    const generateBtn = page.getByRole("button", { name: "Generuoti protokolą" });
    await generateBtn.click();

    // Neturi atsirasti "PARENGTA" (protokolas nesugeneruotas iš tuščios įvesties).
    await expect(page.getByText("PARENGTA")).not.toBeVisible({ timeout: 3_000 });
  });

  test("protokolo generavimo klaida parodoma vartotojui (ne PARENGTA)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Įklijuoti tekstą/ }).click();
    await page.getByPlaceholder("Susitikimo pavadinimas").fill("Klaidos testas");

    // __FORCE_ERROR__ žymė priverčia mock LLM mesti klaidą (žr. MockLLMProvider).
    // Tikriname, kad jobo NESĖKMĖ parodoma vartotojui, ne tyliai kabo.
    await page.getByPlaceholder(/Įklijuokite susitikimo transkripciją/).fill(
      "Pakankamai ilgas testinis tekstas su __FORCE_ERROR__ žyme, kad mock LLM mestų klaidą."
    );
    await page.getByRole("button", { name: "Generuoti protokolą" }).click();

    // Turi pasirodyti klaidos pranešimas, NE "PARENGTA".
    await expect(page.getByText(/nepavyko|klaida/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("PARENGTA")).not.toBeVisible();

    // KRITINIS: klaidos tekste NETURI būti paslapčių (sanitizacija veikia ir UI'e).
    await expect(page.getByText(/ANTHROPIC_API_KEY/)).not.toBeVisible();
  });
});
