// FAZIŲ PERĖJIMŲ TESTAS NARŠYKLĖJE (#154, 8 žingsnis).
//
// ⚠️ TAI NĖRA PILNAS E2E. `GET /api/transcribe-jobs/:id` yra PERIMTAS, tad
// backend fazių gamintojas čia netikrinamas – jį dengia 4–6 žingsnių testai
// (`jobPhasePipeline`, `jobPhaseStore`, `jobPhaseApi`).
//
// Šis testas tikrina VIENĄ dalyką: ar naršyklė teisingai reaguoja į fazių
// kontraktą ir keičia vartotojui matomą būseną.
//
// KODĖL PERIMAMAS API. Mock provideris transkribuoja per milisekundes, tad
// fazių keitimasis įvyktų greičiau, nei Playwright spėtų perskaityti UI –
// testas taptų lenktynėmis. Sulėtinti providerį reikštų testinį elgesį
// produkciniame kode IR vis tiek priklausomybę nuo polling intervalo.
//
// ⚠️ SEKA VALDOMA STATE'U SU ACKNOWLEDGEMENT, ne kvietimų skaičiumi.
//
// Skaičiuoti „trečias poll'as grąžina diarizaciją" būtų trapu: UI gali pollinti
// 1, 2 ar 4 kartus iki pirmojo patikrinimo.
//
// Bet vien `dabartine = "diarizing"` irgi NEPAKANKA – tai ne handshake su
// polling mechanizmu. Be patvirtinimo, kad naršyklė REALIAI gavo naują būseną,
// kritęs testas neleistų atskirti dviejų visiškai skirtingų priežasčių:
//
//   (a) UI naujos būsenos negavo (polling neįvyko, route nesuveikė);
//   (b) UI gavo, bet neatvaizdavo (frontend regresija).
//
// Todėl `route` handler'is praneša, KURIĄ būseną jis grąžino, ir testas laukia
// to patvirtinimo prieš tikrindamas DOM:
//
//   testas keičia state → UI pollina → handler grąžina → testas gauna ACK →
//   tik tada tikrinamas mygtukas.
//
// Polling intervalas yra 3 s (`stenogramaApi.js:176`).

import { test, expect } from "@playwright/test";
import fs from "fs";

/**
 * Minimalus validus WAV header.
 *
 * Turinys nesvarbus – `POST /api/transcribe-jobs` perimtas, tad failas iki
 * backend'o nekeliauja. Reikalingas tik tam, kad naršyklės `input[type=file]`
 * priimtų ir frontend'as leistų paspausti mygtuką.
 */
const WAV_BAITAI = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]);

/** Būsenos, kurias testas grąžina iš perimto endpoint'o. */
const BUSENOS = {
  transcribing: {
    status: "processing",
    phase: "transcribing",
    progressKnown: true,
    progress: { current: 100, total: 100 },
  },
  diarizing: {
    status: "processing",
    phase: "diarizing",
    progressKnown: false,
    progress: null,
  },
  merging: {
    status: "processing",
    phase: "merging",
    progressKnown: false,
    progress: null,
  },
  completed: {
    status: "completed",
    phase: null,
    progressKnown: false,
    progress: null,
    result: { text: "Testinė transkripcija.", segments: [], language: "lt" },
  },
};

test("fazių perėjimai matomi naršyklėje, o pasenęs progresas dingsta", async ({ page }, testInfo) => {
  /**
   * ⚠️ Failas kuriamas Playwright LAIKINAME kataloge, ne repo medyje.
   *
   * `e2e/fixtures/` yra gitignored, tad untracked failo neliktų – bet testas
   * neturi keisti darbo medžio be reikalo. `testInfo.outputPath()` valomas
   * automatiškai ir izoliuotas tarp lygiagrečių paleidimų.
   */
  const wavPath = testInfo.outputPath("test-audio.wav");
  fs.writeFileSync(wavPath, WAV_BAITAI);

  const JOB_ID = "11111111-1111-4111-8111-111111111111";

  /** Valdomas state – testas jį keičia, kai ankstesnę būseną jau patvirtino. */
  let dabartine = "transcribing";

  /** Pranešimas testui, kurią būseną `route` handler'is realiai grąžino. */
  let praneštiApiePoll = null;

  await page.route("**/api/transcribe-jobs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ jobId: JOB_ID, status: "queued" }),
    });
  });

  await page.route(`**/api/transcribe-jobs/${JOB_ID}`, async (route) => {
    const grąžinama = dabartine;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: JOB_ID, variant: "original", ...BUSENOS[grąžinama] }),
    });

    // ACK PO `fulfill` – patvirtinam, kad atsakymas realiai išsiųstas.
    praneštiApiePoll?.(grąžinama);
    praneštiApiePoll = null;
  });

  /**
   * Pakeičia būseną ir LAUKIA, kol naršyklė ją gaus.
   *
   * `waitForRequest` neužtektų: jis įrodo, kad užklausa prasidėjo, bet ne kad
   * handler'is grąžino BŪTENT naują būseną. Lenktynių langas tarp state
   * pakeitimo ir jau vykstančio poll'o liktų atviras.
   */
  async function pereitiĮFazę(faze, timeoutMs = 15000) {
    const ack = new Promise((resolve) => {
      praneštiApiePoll = resolve;
    });

    /**
     * ⚠️ SAVAS TIMEOUT, ne bendras Playwright testo.
     *
     * Be jo polling'ui sustojus laukimą nutrauktų tik viso testo timeout, ir CI
     * parodytų bendrą „test timeout" vietoj konkrečios priežasties. Skirtumas
     * praktinis: „diarizing poll neįvyko per 15 s" iš karto nurodo, kur ieškoti,
     * o „testas užstrigo" – ne.
     */
    let laikmatis;
    const nutrūkimas = new Promise((_, reject) => {
      laikmatis = setTimeout(
        () => reject(new Error(`Poll'as fazei "${faze}" neįvyko per ${timeoutMs} ms`)),
        timeoutMs
      );
    });

    dabartine = faze;

    try {
      expect(await Promise.race([ack, nutrūkimas])).toBe(faze);
    } finally {
      clearTimeout(laikmatis);
      praneštiApiePoll = null;
    }
  }

  await page.goto("/");
  await page.setInputFiles('input[type="file"]', wavPath);
  await page.getByRole("button", { name: /Transkribuoti automatiškai/i }).click();

  // 1. Transkribavimas su žinomu progresu.
  await expect(page.getByRole("button", { name: /Transkribuojama\.\.\. 100 %/ })).toBeVisible({
    timeout: 15000,
  });

  // 2. Diarizacija – progresas nebežinomas.
  await pereitiĮFazę("diarizing");
  await expect(page.getByRole("button", { name: /Atliekama diarizacija/ })).toBeVisible({
    timeout: 15000,
  });

  /**
   * ⚠️ ESMINĖ REGRESIJA. Būtent „užstrigęs 100 %" ir buvo #154 pradinė
   * problema: transkripcija baigėsi, diarizacija progreso neteikia, ir
   * vartotojui atrodė, kad darbas pakibo.
   */
  await expect(page.getByRole("button", { name: /100 %/ })).toHaveCount(0);

  // 3. Sujungimas – dar viena fazė be progreso.
  await pereitiĮFazę("merging");
  await expect(page.getByRole("button", { name: /Jungiami kalbėtojai/ })).toBeVisible({
    timeout: 15000,
  });

  // 4. Pabaiga – transkripcija patenka į formą.
  await pereitiĮFazę("completed");
  await expect(page.locator("textarea").first()).toContainText("Testinė transkripcija", {
    timeout: 15000,
  });
});
