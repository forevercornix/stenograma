const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AuditKeyConfigError,
  HISTORICAL_SOFT_LIMIT,
  resolveKeyRing,
  secretFor,
  subjectIdFor,
  candidateSubjectIds,
} = require("../utils/auditStore/keyRing");

/**
 * AUDITO RAKTŲ ŽIEDAS (#155, 7.4c / #212).
 *
 * ⚠️ ŠIS MODULIS YRA VIENINTELIS AUTORITETAS.
 *
 * `AUDIT_ID_SALT_PREVIOUS` parsinamas TIK čia. Trys kopijos (užklausa, ištrynimas,
 * startas) išsiskirtų tyliai, o kaina būtų GDPR: ištrynimas apskaičiuotų kitą
 * kandidatų aibę nei paieška, ir dalis įrašų liktų nepasiekiami. 7.4b peržiūra
 * tą pačią „dvi konfigūracijos" ydą rado keturis kartus - čia ji uždaroma iš anksto.
 */

/** Base64url reikšmės; tikrų secret'ų testuose nėra ir būti negali. */
const AKTYVUS = "YWt0eXZ1cy1zZWNyZXQ";
const ISTORINIS_B = "aXN0b3JpbmlzLWI";
const ISTORINIS_C = "aXN0b3JpbmlzLWM";

const PILNAS = Object.freeze({
  AUDIT_ID_SALT_ID: "2026-08",
  AUDIT_ID_SALT: AKTYVUS,
  AUDIT_ID_SALT_PREVIOUS: `2026-07:${ISTORINIS_B},2026-06:${ISTORINIS_C}`,
});

const PG = { reikalaujamaAktyvausId: true };

test("KONFIGŪRACIJA: aktyvus raktas ir istoriniai išparsinami į vieną aibę", () => {
  const ring = resolveKeyRing(PILNAS, PG);

  assert.equal(ring.activeId, "2026-08");
  assert.equal(ring.activeSecret, AKTYVUS);
  assert.deepEqual(
    ring.historical.map((k) => k.id),
    ["2026-07", "2026-06"],
    "istorinių tvarka išlaikoma tokia, kokią nurodė operatorius"
  );
  assert.equal(ring.historicalCount, 2);

  assert.equal(secretFor(ring, "2026-07"), ISTORINIS_B);
  assert.equal(secretFor(ring, "nezinoma"), null, "nežinoma generacija neturi rakto");
});

test("KONFIGŪRACIJA: atminties režimu aktyvus ID neprivalomas", () => {
  /**
   * 7.4b `AUDIT_ID_SALT_ID` reikalauja TIK persistentiniam backend'ui - atmintyje
   * `hash_key_id` niekur nerašomas. Reikalavimas jo visur sulaužytų esamus
   * atminties diegimus be jokios naudos.
   */
  const ring = resolveKeyRing({ AUDIT_ID_SALT: AKTYVUS });

  assert.equal(ring.activeId, null);
  assert.equal(ring.activeSecret, AKTYVUS);
  assert.equal(ring.historicalCount, 0);
});

test("KONFIGŪRACIJA: netaisyklingi variantai NUTRAUKIA startą", () => {
  const netinkami = [
    ["aktyvus ID trūksta", { AUDIT_ID_SALT: AKTYVUS }, /AUDIT_ID_SALT_ID/],
    ["aktyvus ID tuščias", { AUDIT_ID_SALT_ID: "  ", AUDIT_ID_SALT: AKTYVUS }, /AUDIT_ID_SALT_ID/],
    [
      "aktyvus ID su tarpu",
      { AUDIT_ID_SALT_ID: "2026 08", AUDIT_ID_SALT: AKTYVUS },
      /netinkamo formato/,
    ],
    [
      "aktyvus secret trūksta",
      { AUDIT_ID_SALT_ID: "2026-08" },
      /secret'as tuščias/,
    ],
    [
      "istorinis be dvitaškio",
      { ...PILNAS, AUDIT_ID_SALT_PREVIOUS: "sugadinta" },
      /be dvitaškio/,
    ],
    [
      "istorinis su tuščiu secret'u",
      { ...PILNAS, AUDIT_ID_SALT_PREVIOUS: "2026-07:" },
      /secret'as tuščias/,
    ],
    [
      "istorinis su tuščiu ID",
      { ...PILNAS, AUDIT_ID_SALT_PREVIOUS: `:${ISTORINIS_B}` },
      /ID tuščias/,
    ],
    [
      "istorinių ID dublikatas",
      { ...PILNAS, AUDIT_ID_SALT_PREVIOUS: `dup:${ISTORINIS_B},dup:${ISTORINIS_C}` },
      /kartojasi/,
    ],
    [
      "kolizija su aktyviu ID",
      { ...PILNAS, AUDIT_ID_SALT_PREVIOUS: `2026-08:${ISTORINIS_B}` },
      /kartojasi/,
    ],
    [
      "secret su neleistinu simboliu",
      { ...PILNAS, AUDIT_ID_SALT_PREVIOUS: "2026-07:blogas secret" },
      /netinkamo formato/,
    ],
  ];

  for (const [pavadinimas, env, sablonas] of netinkami) {
    assert.throws(
      () => resolveKeyRing(env, PG),
      (e) => e instanceof AuditKeyConfigError && sablonas.test(e.message),
      `${pavadinimas}: privalo nutraukti startą`
    );
  }
});

test("SAUGUMAS: klaidų tekstuose NĖRA secret'ų", () => {
  /**
   * ⚠️ Startup klaidos patenka į logus ir orkestruotojo išvestį. Secret'as jose
   * reikštų nutekėjimą būtent tada, kai operatorius kopijuoja klaidą į ticket'ą.
   * `hash_key_id` yra ETIKETĖ ir minėti jį leidžiama; secret'as - ne.
   */
  const netinkami = [
    { ...PILNAS, AUDIT_ID_SALT_PREVIOUS: `2026-07:${ISTORINIS_B},2026-07:${ISTORINIS_C}` },
    { ...PILNAS, AUDIT_ID_SALT_PREVIOUS: "2026-07:blogas secret" },
    { ...PILNAS, AUDIT_ID_SALT_PREVIOUS: `${AKTYVUS}` },
    { AUDIT_ID_SALT_ID: "2026-08" },
  ];

  for (const env of netinkami) {
    let pranesimas = null;
    try {
      resolveKeyRing(env, PG);
    } catch (e) {
      pranesimas = e.message;
    }

    assert.ok(pranesimas, "prielaida: konfigūracija netinkama");

    for (const secret of [AKTYVUS, ISTORINIS_B, ISTORINIS_C]) {
      assert.ok(
        !pranesimas.includes(secret),
        `secret'as nutekėjo į klaidos tekstą: ${pranesimas.slice(0, 80)}`
      );
    }
  }
});

test("FAN-OUT: kandidatų aibę apibrėžia DB generacijos, ne env sąrašo ilgis", () => {
  /**
   * ⚠️ #212: „Fan-out autoritetas yra DB, ne env sąrašo ilgis."
   *
   * Konfigūracijoje likęs raktas, kurio DB įrašų nebėra, kandidatų aibės NEDIDINA -
   * kitaip kiekviena rotacija amžinai brangintų kiekvieną paiešką ir ištrynimą.
   */
  const ring = resolveKeyRing(PILNAS, PG);

  const tikA = candidateSubjectIds(ring, "job-1", ["2026-08"]);
  const suB = candidateSubjectIds(ring, "job-1", ["2026-08", "2026-07"]);
  const visos = candidateSubjectIds(ring, "job-1", ["2026-08", "2026-07", "2026-06"]);

  assert.equal(tikA.length, 1);
  assert.equal(suB.length, 2);
  assert.equal(visos.length, 3);

  /** ⚠️ Aktyvus raktas įtraukiamas VISADA - juo rašomi nauji įrašai. */
  const beAktyvausDb = candidateSubjectIds(ring, "job-1", ["2026-07"]);
  assert.equal(beAktyvausDb.length, 2, "aktyvus privalo būti net kai DB jo dar neturi");
  assert.ok(beAktyvausDb.includes(subjectIdFor(AKTYVUS, "job-1")));

  /** Nežinoma DB generacija be rakto kandidato nesukuria (fail-closed sprendžia startas). */
  assert.equal(candidateSubjectIds(ring, "job-1", ["2026-08", "dingusi"]).length, 1);

  /**
   * ⚠️ TUŠČIAS SĄRAŠAS - „NEŽINOMA", NE „NĖRA".
   *
   * Atminties backend'as `hash_key_id` nesaugo ir grąžina tuščią sąrašą.
   * Supratus tai kaip „generacijų nėra", kandidatas liktų vienas, ir po
   * rotacijos to paties proceso metu seni įrašai taptų NEIŠTRINAMI. Todėl be
   * informacijos naudojami visi sukonfigūruoti raktai.
   */
  assert.equal(
    candidateSubjectIds(ring, "job-1", []).length,
    3,
    "be DB informacijos fan-out apima visus sukonfigūruotus raktus"
  );
});

test("FAN-OUT: kiekviena generacija duoda SKIRTINGĄ pseudonimą", () => {
  /**
   * Jei pseudonimai sutaptų, rotacija nieko nekeistų, o `hash_key_id` būtų
   * dekoracija. Tai ir yra priežastis, dėl kurios ištrynimas privalo apeiti
   * VISAS generacijas.
   */
  const ring = resolveKeyRing(PILNAS, PG);
  const kandidatai = candidateSubjectIds(ring, "job-1", ["2026-08", "2026-07", "2026-06"]);

  assert.equal(new Set(kandidatai).size, 3, "skirtingi raktai privalo duoti skirtingus pseudonimus");
  for (const k of kandidatai) assert.match(k, /^[0-9a-f]{20}$/, "formatas kaip 7.4a");
});

test("FAN-OUT: tuščias identifikatorius kandidatų NEGENERUOJA", () => {
  /** Kitaip `removeBySubjectIdentifier(null)` ištrintų viską, kas atitinka tuščią HMAC. */
  const ring = resolveKeyRing(PILNAS, PG);

  for (const tuscia of [null, undefined, ""]) {
    assert.deepEqual(candidateSubjectIds(ring, tuscia, ["2026-08"]), []);
  }
});

test("KIEKIO RIBA: pati savaime NEATMETA konfigūracijos", () => {
  /**
   * ⚠️ #212 spąstai: „maks. N istorinių" + „rakto negalima pašalinti, kol DB yra
   * jo įrašų" naiviai suporuoti duotų nepaleidžiamą backend'ą. Todėl žiedas ribos
   * NEVYKDO - jis tik praneša kiekį, o sprendimą priima `auditStore/index.js`,
   * kuris mato, kurie raktai DB įrašų dar turi.
   */
  const daug = Array.from({ length: HISTORICAL_SOFT_LIMIT + 1 }, (_, i) => `g${i}:${ISTORINIS_B}`);

  const ring = resolveKeyRing({ ...PILNAS, AUDIT_ID_SALT_PREVIOUS: daug.join(",") }, PG);

  assert.equal(ring.historicalCount, HISTORICAL_SOFT_LIMIT + 1, "riba čia neturi mesti");
  assert.equal(HISTORICAL_SOFT_LIMIT, 10, "riba pagal #212");
});
