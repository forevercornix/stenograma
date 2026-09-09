const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { Client, Pool } = require("pg");

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

/**
 * `job_results` PERĖJIMŲ PRIĖMIMO SRITIS — IŠMATUOTA, NE NUMANYTA (#157, PR-6).
 *
 * ⚠️ KODĖL ATSKIRAS FAILAS NUO `jobResultsExternalShape.integration`.
 *
 * Anas tikrina, kurias `job_results` eilutes DB priima ĮRAŠANT (`INSERT`) —
 * t. y. formos STATIKĄ. Čia tikrinama kita dimensija: kurias eilutes DB priima
 * PEREINANT iš vienos galiojančios formos į kitą (`UPDATE`). Statinis
 * invariantas nieko nesako apie tai, ar perėjimą galima IŠSKAIDYTI: abu
 * galiniai taškai gali būti teisėti, o klausimas yra apie tarpines būsenas.
 *
 * ⚠️ KLAUSIMAS, KURĮ ŠIS FAILAS ATSAKO.
 *
 * PR-6 planas §9.1 numatė mutaciją „du `UPDATE` atskirose transakcijose" —
 * prielaida, kad reference switch (`inline` → external) yra išskaidomas, ir kad
 * tarp dviejų sakinių egzistuoja commit'inta tarpinė būsena, kurią stebėtojas
 * gali pamatyti. Ta prielaida NEBUVO patikrinta. Jei `job_results_storage_shape`
 * kiekvieną tarpinę formą atmeta, seka dvi pasekmės:
 *
 *   1. tikrasis sargas yra `CHECK`, ne migracijos kodo tvarka — tad §9.1
 *      stebėtojas įrodytų mažiau, nei planas žadėjo;
 *   2. atomiškumo nereikia SAUGOTI — jis yra schemos savybė.
 *
 * Abi pasekmės priklauso nuo to, ką PostgreSQL REALIAI daro, tad atsakymas
 * paimamas matavimu, ne migracijos skaitymu (AGENTS.md §14.1: perskaityta
 * sąlyga yra prisiminimas, ne įrodymas).
 *
 * ⚠️ KODĖL TAI LIEKA NUOLATINIU TESTU, O NE VIENKARTINE ATASKAITA.
 *
 * Ta pati šeima kaip `jobResultsJsonbDomain.integration`: „kurias reikšmes PG
 * priima" fiksuojama TVIRTINIMU, kuris krenta pasikeitus elgesiui. Vienkartinis
 * matavimas laikinoje šakoje atsako į šiandienos klausimą ir nieko negina
 * rytoj — o būtent taip PR-4 mutacijos vos nedingo kartu su ištrinta šaka.
 * Susilpninus `job_results_storage_shape`, šis failas pasakys tai iškart.
 *
 * ⚠️ ŠIS FAILAS VIETOJE NEVYKDOMAS — reikia tikros PostgreSQL. Registracija
 * `postgres` rinkinyje išvedama iš `postgresGuard` importo, tad
 * `verify-postgres-suite-ran.mjs` reikalaus neprapleisto `ok`.
 */

const ŠAKNIS = path.resolve(__dirname, "..");
const DB_URL = testDatabaseUrl("shapedomain");
const PRALEISTI = skipWithoutPostgres();

const RAKTAS = "results/aaaaaaaa-0000-4000-8000-000000000002/abc.json";
const SUMA = "e".repeat(64);
const PAYLOAD = JSON.stringify({ text: "x" });

/**
 * PENKI PRISKYRIMAI, IŠ KURIŲ SUSIDEDA REFERENCE SWITCH.
 *
 * ⚠️ SKAIDYMO ERDVĖ IŠVEDAMA, NE ATRENKAMA RANKA.
 *
 * Ranka parinktos „būdingos" formos atsako tik apie save: praleista septintoji
 * forma, kurią DB priima, yra tiksliai ta spraga, dėl kurios matavimas ir
 * daromas. Todėl tikrinami VISI netušti tikri poaibiai — 2^5 - 2 = 30 kiekviena
 * kryptimi.
 *
 * ⚠️ TAI PADENGIA IR ILGESNIUS SKAIDYMUS. Bet kurio N sakinių skaidymo PIRMASIS
 * sakinys yra tikras poaibis; jei kiekvienas tikras poaibis atmetamas, joks
 * skaidymas — nei dviejų, nei trijų sakinių — negali turėti commit'intos
 * tarpinės būsenos. Vienas išmatuotas rinkinys uždaro visą klasę.
 */
const Į_EXTERNAL = [
  { stulpelis: "storage_type", reiksme: "fs" },
  { stulpelis: "storage_key", reiksme: RAKTAS },
  { stulpelis: "payload", reiksme: null },
  { stulpelis: "bytes", reiksme: 1024 },
  { stulpelis: "checksum", reiksme: SUMA },
];

const Į_INLINE = [
  { stulpelis: "storage_type", reiksme: "inline" },
  { stulpelis: "storage_key", reiksme: null },
  { stulpelis: "payload", reiksme: PAYLOAD },
  { stulpelis: "bytes", reiksme: null },
  { stulpelis: "checksum", reiksme: null },
];

/** Pradinės (galiojančios) eilučių formos. */
const INLINE_EILUTĖ = { storage_type: "inline", payload: PAYLOAD };
const EXTERNAL_EILUTĖ = { storage_type: "fs", storage_key: RAKTAS, bytes: 1024, checksum: SUMA };

let pool = null;

async function pg(url, sql, params = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

function dbVardas() {
  return new URL(DB_URL).pathname.replace(/^\//, "");
}

async function perkurtiDb() {
  const admin = adminDatabaseUrl();
  await pg(admin, `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`);
  await pg(admin, `CREATE DATABASE "${dbVardas()}"`);
  execFileSync("npx", ["node-pg-migrate", "up"], {
    cwd: ŠAKNIS,
    env: { ...process.env, DATABASE_URL: DB_URL },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  pool = new Pool({ connectionString: DB_URL });
}

after(async () => {
  if (PRALEISTI) return;
  if (pool) await pool.end().catch(() => {});
  await pg(adminDatabaseUrl(), `DROP DATABASE IF EXISTS "${dbVardas()}" WITH (FORCE)`).catch(() => {});
});

/**
 * Sukuria job'ą ir jam VIENĄ galiojančią `job_results` eilutę.
 *
 * ⚠️ NAUJA EILUTĖ KIEKVIENAM BANDYMUI. `job_id` yra pirminis raktas, o
 * pakartotinis to paties įrašo naudojimas reikštų, kad ankstesnio bandymo
 * pasekmės (jei DB kurią nors formą PRIIMTŲ) nutekėtų į kitą — ir matavimas
 * pasakotų apie kaupiamąją būseną, ne apie atskirą perėjimą.
 */
async function naujaEilutė(forma) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (id, type, status, created_at, updated_at)
     VALUES (gen_random_uuid(), 'transcription', 'completed', now(), now()) RETURNING id`
  );
  const jobId = rows[0].id;

  const stulpeliai = Object.keys(forma);
  const reikšmės = stulpeliai.map((_, i) => `$${i + 2}`);
  await pool.query(
    `INSERT INTO job_results (job_id, created_at, ${stulpeliai.join(", ")})
     VALUES ($1, now(), ${reikšmės.join(", ")})`,
    [jobId, ...stulpeliai.map((s) => forma[s])]
  );

  return jobId;
}

/**
 * Įvykdo VIENĄ `UPDATE` su duotu priskyrimų poaibiu.
 *
 * ⚠️ GRĄŽINAMAS SQLSTATE IR SUVARŽYMO VARDAS, NE `boolean` (PR-1 pamoka).
 *
 * „Atmesta" gali reikšti `23514` ties `job_results_storage_shape` (invariantas
 * suveikė — tai atsakymas į klausimą), bet lygiai taip pat `23514` ties
 * `job_results_integrity_shape` (bloga `bytes`/`checksum` reikšmė), `42703`
 * (stulpelio nėra) ar `23502` (NOT NULL). Testas, tenkinęsis „krito", žaliuotų
 * dėl neteisingos priežasties ir teigtų atomiškumą, kurio neišmatavo.
 */
async function bandytiPoaibį(pradžia, priskyrimai) {
  const jobId = await naujaEilutė(pradžia);
  const sakinys = priskyrimai.map((p, i) => `${p.stulpelis} = $${i + 2}`).join(", ");

  try {
    await pool.query(
      `UPDATE job_results SET ${sakinys} WHERE job_id = $1`,
      [jobId, ...priskyrimai.map((p) => p.reiksme)]
    );
    return { kodas: null, suvaržymas: null };
  } catch (klaida) {
    return { kodas: klaida.code, suvaržymas: klaida.constraint ?? null };
  }
}

/** Visi netušti TIKRI poaibiai (be pilno rinkinio) – 2^n - 2. */
function tikriPoaibiai(priskyrimai) {
  const visi = [];
  const pilnas = (1 << priskyrimai.length) - 1;

  for (let kaukė = 1; kaukė < pilnas; kaukė += 1) {
    visi.push(priskyrimai.filter((_, i) => (kaukė & (1 << i)) !== 0));
  }

  return visi;
}

function vardas(priskyrimai) {
  return priskyrimai.map((p) => p.stulpelis).join("+");
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. SKAIDYMO ERDVĖ ABIEM KRYPTIMIS
 * ═══════════════════════════════════════════════════════════════════════════ */

const KRYPTYS = [
  { vardas: "inline → external", pradžia: INLINE_EILUTĖ, priskyrimai: Į_EXTERNAL },
  { vardas: "external → inline", pradžia: EXTERNAL_EILUTĖ, priskyrimai: Į_INLINE },
];

test(
  "#157 PR-6: reference switch NEIŠSKAIDOMAS — kiekviena tarpinė forma atmetama",
  { skip: PRALEISTI, timeout: 300000 },
  async (t) => {
    await perkurtiDb();

    for (const kryptis of KRYPTYS) {
      const poaibiai = tikriPoaibiai(kryptis.priskyrimai);
      const verdiktai = [];

      for (const poaibis of poaibiai) {
        const r = await bandytiPoaibį(kryptis.pradžia, poaibis);
        verdiktai.push({ vardas: vardas(poaibis), ...r });
      }

      await t.test(`${kryptis.vardas}: nė vienas dalinis sakinys NEPRAEINA`, () => {
        /**
         * ⚠️ JEI ŠIS TVIRTINIMAS KRENTA, TAI SVARBIAU UŽ VISĄ LIKUSĮ PR-6.
         *
         * Praėjęs dalinis sakinys reiškia commit'intą tarpinę būseną: eilutę,
         * kuri arba rodo į objektą jo neaprašiusi, arba aprašo objektą jo
         * neberodydama. Tada `CHECK` turi spragą, ir ją reikia uždaryti PRIEŠ
         * rašant migraciją, o ne aprašyti stebėtoju.
         */
        assert.deepEqual(
          verdiktai.filter((v) => v.kodas === null).map((v) => v.vardas),
          [],
          `${kryptis.vardas}: DB PRIĖMĖ dalinį perėjimą — commit'inta tarpinė būsena EGZISTUOJA`
        );
      });

      await t.test(`${kryptis.vardas}: atmeta būtent \`job_results_storage_shape\``, () => {
        /**
         * ⚠️ BE ŠITO ankstesnis tvirtinimas praeitų ir tuo atveju, jei sakiniai
         * kristų dėl nesamo stulpelio (`42703`) — t. y. dėl nepritaikytos
         * migracijos. Tai tiksliai ta klaida, kurią PR-1 rado raudonu raundu:
         * visi keturi sargai krito, bet ne dėl invarianto.
         */
        const kitokie = verdiktai
          .filter((v) => v.kodas !== "23514" || v.suvaržymas !== "job_results_storage_shape")
          .map((v) => `${v.vardas} (${v.kodas} ${v.suvaržymas || "-"})`);

        assert.deepEqual(kitokie, [], `${kryptis.vardas}: atmetimo priežastis NE formos invariantas`);
      });

      await t.test(`${kryptis.vardas}: KONTROLĖ — pilnas perėjimas vienu sakiniu PRAEINA`, async () => {
        /**
         * ⚠️ BE JOS visas matavimas būtų tenkinamas ir tada, jei `UPDATE`
         * krenta VISADA — pvz. dėl trigerio ar atšauktos teisės. „Nė vienas
         * skaidymas neveikia" tada reikštų „niekas neveikia", ir išvada apie
         * atomiškumą būtų neteisinga dėl teisingo rezultato.
         */
        const r = await bandytiPoaibį(kryptis.pradžia, kryptis.priskyrimai);
        assert.deepEqual(
          r,
          { kodas: null, suvaržymas: null },
          `${kryptis.vardas}: pilnas perėjimas privalo praeiti, kitaip matavimas nieko nesako`
        );
      });

      await t.test(`${kryptis.vardas}: KONTROLĖ — ištirta visa skaidymo erdvė`, () => {
        /**
         * Sugedęs poaibių generatorius (tuščias sąrašas) padarytų abu ankstesnius
         * tvirtinimus tuščiai teisingus. Skaičius užrašomas kaip 2^n - 2, o ne
         * kaip „30": pridėjus šeštą stulpelį, lūžti privalo generatorius, ne
         * konstanta.
         */
        assert.equal(verdiktai.length, 2 ** kryptis.priskyrimai.length - 2);
        assert.ok(verdiktai.length > 0, "skaidymo erdvė tuščia — matavimas neįvyko");
      });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. TRANSAKCIJA NĖRA IŠEITIS
 * ═══════════════════════════════════════════════════════════════════════════ */

test(
  "#157 PR-6: skaidymas neišgelbstimas nei bendra transakcija, nei atidėjimu",
  { skip: PRALEISTI, timeout: 180000 },
  async (t) => {
    if (!pool) await perkurtiDb();

    await t.test("`job_results_storage_shape` NĖRA `DEFERRABLE`", async () => {
      /**
       * ⚠️ STRUKTŪRINĖ, NE STEBĖTA SAVYBĖ. Vienas nepavykęs bandymas atidėti
       * įrodo tik tą bandymą; katalogo įrašas pasako, kad atidėti apskritai
       * nėra ko — ir kris, jei kas nors kada suvaržymą perkurs atidedamą.
       */
      const { rows } = await pool.query(
        "SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'job_results_storage_shape'"
      );

      assert.equal(rows.length, 1, "suvaržymo nėra — matavimas kalbėtų apie tuštumą");
      assert.equal(rows[0].condeferrable, false);
      assert.equal(rows[0].condeferred, false);
    });

    await t.test("dalinis sakinys krenta IŠ KARTO, o ne commit'o metu", async () => {
      /**
       * ⚠️ SKIRTUMAS SVARBUS PR-6 MIGRACIJAI. Jei `CHECK` būtų tikrinamas tik
       * commit'e, migracija galėtų teisėtai rašyti du sakinius vienoje
       * transakcijoje, ir §9.1 stebėtojas turėtų ką stebėti. Tikrinama tiesiai:
       * sakinys viduje transakcijos privalo mesti PATS.
       */
      const jobId = await naujaEilutė(INLINE_EILUTĖ);
      const klientas = await pool.connect();

      try {
        await klientas.query("BEGIN");
        /** Atidėjimas prašomas EKSPLICITIŠKAI — kad „o gal su juo veiktų" liktų atsakytas. */
        await klientas.query("SET CONSTRAINTS ALL DEFERRED");

        let kodas = null;
        let suvaržymas = null;
        try {
          await klientas.query(
            "UPDATE job_results SET storage_type = 'fs', storage_key = $2 WHERE job_id = $1",
            [jobId, RAKTAS]
          );
        } catch (klaida) {
          kodas = klaida.code;
          suvaržymas = klaida.constraint ?? null;
        }

        assert.equal(kodas, "23514", "sakinys transakcijoje privalo kristi PATS, ne commit'o metu");
        assert.equal(suvaržymas, "job_results_storage_shape");
      } finally {
        await klientas.query("ROLLBACK").catch(() => {});
        klientas.release();
      }
    });
  }
);
