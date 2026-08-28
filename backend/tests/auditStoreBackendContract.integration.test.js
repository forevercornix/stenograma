const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Pool } = require("pg");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { skipWithoutPostgres, testDatabaseUrl, adminDatabaseUrl } = require("./helpers/postgresGuard");
const { sukurtiResursuKruva } = require("./helpers/resourceStack");
const memoryStore = require("../utils/auditStore/memoryStore");
const { createPostgresStore } = require("../utils/auditStore/postgresStore");
const { visiLaukai, META_LAUKAI } = require("../utils/auditStore/fields");

/**
 * AUDITO BACKEND'Ų KONTRAKTO EKVIVALENTUMAS (#155, 7.4b / #211).
 *
 * ⚠️ VIENAS SCENARIJŲ SĄRAŠAS, DU ADAPTERIAI.
 *
 * #211 to reikalauja eksplicitiškai: dvi nepriklausomos to paties elgesio
 * kopijos išsiskiria tyliai. Job store pusėje tai jau įvyko (#155: `tenantId`,
 * `created_at`, tipų konvertavimas), o audito atveju divergencija reikštų, kad
 * GDPR ištrynimo ir skaitymo semantika priklauso nuo `AUDIT_BACKEND` reikšmės.
 *
 * ⚠️ REGISTRUOTAS DVIEJUOSE RINKINIUOSE (`security` ir `postgres`): `security`
 * paleidžia jį kiekviename `npm test` (atminties adapteris), `postgres` -
 * `npm run test:postgres` su tikru `DATABASE_URL`.
 */

const HASH_KEY_ID = "kontraktas-2026-08";

/** Pilna `record()` formos eilutė - visi laukai, kad paritetas būtų tikrinamas visas. */
function eilute(perrasymai = {}) {
  const bazė = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    event: "PROCESSING_COMPLETED",
    subjectId: null,
    result: "success",
    requestId: null,
  };

  for (const laukas of META_LAUKAI) bazė[laukas] = null;

  return { ...bazė, ...perrasymai };
}

const SCENARIJAI = [
  {
    id: "irasas-grazinamas-tokios-pat-formos",
    kodel: "append() grąžina objektą su TIKSLIAI tais pačiais raktais abiejuose backend'uose",
    async run({ store }) {
      const grazinta = await store.append(eilute({ subjectId: "pseudo-1", details: "x=1" }));

      assert.deepEqual(
        Object.keys(grazinta).sort(),
        visiLaukai().sort(),
        "raktų aibė privalo sutapti - kitaip /api/audit atsakymas priklausytų nuo backend'o"
      );
      assert.equal(grazinta.details, "x=1");
      assert.equal(grazinta.subjectId, "pseudo-1");
    },
  },
  {
    id: "nenurodyti-meta-laukai-yra-null",
    kodel: "trūkstamas `meta` laukas grąžinamas kaip null, ne undefined",
    async run({ store }) {
      const grazinta = await store.append(eilute());

      for (const laukas of META_LAUKAI) {
        assert.ok(laukas in grazinta, `${laukas} privalo egzistuoti raktų aibėje`);
        assert.equal(grazinta[laukas], null, `${laukas} privalo būti null, ne undefined`);
      }
    },
  },
  {
    id: "tvarka-deterministine-vienam-momentui",
    kodel: "VIENU MOMENTU įrašytos eilutės skaitomos įrašymo tvarka",
    async run({ store, vienuMomentu }) {
      /**
       * ⚠️ ŠIS SCENARIJUS YRA #211 TVARKOS REIKALAVIMO ESMĖ.
       *
       * PostgreSQL `now()` VIENOJE TRANSAKCIJOJE visoms eilutėms grąžina tą patį
       * momentą. `ORDER BY timestamp` tokiu atveju būtų neapibrėžtas, o
       * `ORDER BY id` - beprasmis (`randomUUID()` nemonotoniškas). Tvarką
       * garantuoja `seq`, atitinkantis atminties masyvo indeksą.
       */
      const zymos = ["pirmas", "antras", "trecias", "ketvirtas", "penktas"];

      await vienuMomentu(zymos.map((z) => eilute({ details: z })));

      const { entries } = await store.list();

      assert.deepEqual(
        entries.map((e) => e.details),
        zymos,
        "vienu momentu įrašytos eilutės privalo išlaikyti įrašymo tvarką"
      );
    },
  },
  {
    id: "riba-taikoma-saugykloje",
    kodel: "list({limit}) grąžina RIBOTĄ puslapį, o `total` lieka pilnas kiekis",
    async run({ store }) {
      for (let i = 0; i < 7; i += 1) await store.append(eilute({ details: `nr-${i}` }));

      const { entries, total } = await store.list({ limit: 3 });

      assert.equal(entries.length, 3, "riba privalo būti pritaikyta");
      assert.equal(total, 7, "`total` yra kiekis PRIEŠ ribą - be jo puslapiavimas būtų aklas");
      assert.deepEqual(entries.map((e) => e.details), ["nr-0", "nr-1", "nr-2"]);
    },
  },
  {
    id: "poslinkis",
    kodel: "offset praleidžia tiksliai tiek eilučių, kiek nurodyta",
    async run({ store }) {
      for (let i = 0; i < 5; i += 1) await store.append(eilute({ details: `nr-${i}` }));

      const { entries, total } = await store.list({ limit: 2, offset: 2 });

      assert.deepEqual(entries.map((e) => e.details), ["nr-2", "nr-3"]);
      assert.equal(total, 5);
    },
  },
  {
    id: "filtrai-pries-riba",
    kodel: "filtrai taikomi PRIEŠ ribą - kitaip `limit` reikštų skirtingus dalykus su filtru ir be jo",
    async run({ store }) {
      for (let i = 0; i < 4; i += 1) await store.append(eilute({ event: "EXPORT_STARTED" }));
      for (let i = 0; i < 6; i += 1) await store.append(eilute({ event: "LOGIN_SUCCESS" }));

      const { entries, total } = await store.list({ event: "LOGIN_SUCCESS", limit: 2 });

      assert.equal(entries.length, 2, "riba galioja ir su filtru");
      assert.equal(total, 6, "`total` skaičiuoja FILTRUOTĄ aibę, ne visą lentelę");
      assert.ok(entries.every((e) => e.event === "LOGIN_SUCCESS"));
    },
  },
  {
    id: "filtras-pagal-request-id",
    kodel: "requestId filtras atrenka koreliuotus įrašus",
    async run({ store }) {
      await store.append(eilute({ requestId: "req-a" }));
      await store.append(eilute({ requestId: "req-b" }));
      await store.append(eilute({ requestId: "req-a" }));

      const { entries, total } = await store.list({ requestId: "req-a" });

      assert.equal(total, 2);
      assert.ok(entries.every((e) => e.requestId === "req-a"));
    },
  },
  {
    id: "tuscias-puslapis",
    kodel: "filtras be atitikmenų grąžina tuščią sąrašą ir total=0, o ne klaidą",
    async run({ store }) {
      await store.append(eilute({ event: "LOGIN_SUCCESS" }));

      const { entries, total } = await store.list({ event: "DATA_ERASED" });

      assert.deepEqual(entries, []);
      assert.equal(total, 0);
    },
  },
  {
    id: "trynimas-pagal-subjekta",
    kodel: "removeBySubject pašalina TIK to subjekto įrašus (GDPR ištrynimas)",
    async run({ store }) {
      await store.append(eilute({ subjectId: "pseudo-trinti" }));
      await store.append(eilute({ subjectId: "pseudo-likti" }));
      await store.append(eilute({ subjectId: "pseudo-trinti" }));

      assert.equal(await store.removeBySubject("pseudo-trinti"), 2, "grąžinamas pašalintų kiekis");

      const { entries } = await store.list();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].subjectId, "pseudo-likti");
    },
  },
  {
    id: "trynimas-be-subjekto",
    kodel: "removeBySubject(null) NIEKO netrina - kitaip tuščias ID išvalytų žurnalą",
    async run({ store }) {
      await store.append(eilute({ subjectId: "pseudo-1" }));

      assert.equal(await store.removeBySubject(null), 0);
      assert.equal(await store.removeBySubject(""), 0);
      assert.equal((await store.list()).total, 1, "žurnalas privalo likti nepaliestas");
    },
  },
  {
    id: "skaiciavimas-pagal-subjekta",
    kodel: "countBySubject atsako be viso žurnalo atsiėmimo",
    async run({ store }) {
      await store.append(eilute({ subjectId: "pseudo-x" }));
      await store.append(eilute({ subjectId: "pseudo-x" }));
      await store.append(eilute({ subjectId: "pseudo-y" }));

      assert.equal(await store.countBySubject("pseudo-x"), 2);
      assert.equal(await store.countBySubject("pseudo-nera"), 0);
      assert.equal(await store.countBySubject(null), 0);
    },
  },
  {
    id: "idempotencija-pagal-id",
    kodel: "tas pats `id` du kartus NESUKURIA antros eilutės (at-least-once)",
    async run({ store }) {
      /**
       * ⚠️ #211: bendros transakcijos su job saugykla NĖRA, tad rašymas yra
       * at-least-once. Pakartojimas po timeout privalo būti nekenksmingas -
       * kitaip vienas įvykis auditą pasiektų du kartus, ir žurnalas meluotų
       * apie įvykių skaičių.
       */
      const irasas = eilute({ details: "pirmas-rasymas" });

      await store.append(irasas);
      await store.append(irasas);

      const { total } = await store.list();
      assert.equal(total, 1, "pakartotinis rašymas su tuo pačiu `id` privalo būti no-op");
    },
  },
  {
    id: "meta-allowlist",
    kodel: "nežinomas laukas NUTYLIMAS - nei saugomas, nei grąžinamas",
    async run({ store }) {
      const grazinta = await store.append(
        eilute({
          details: "leistina",
          transcript: "SLAPTA-TRANSKRIPCIJA-SENTINEL",
          jobId: "PLIKAS-JOB-ID-SENTINEL",
        })
      );

      assert.equal(grazinta.details, "leistina");
      assert.ok(!("transcript" in grazinta), "nežinomas laukas negali grįžti į atsakymą");
      assert.ok(!("jobId" in grazinta), "plikas job ID negali grįžti į atsakymą");

      const serializuota = JSON.stringify((await store.list()).entries);
      assert.ok(!serializuota.includes("SLAPTA-TRANSKRIPCIJA-SENTINEL"));
      assert.ok(!serializuota.includes("PLIKAS-JOB-ID-SENTINEL"));
    },
  },
  {
    id: "kursorius-desc-ir-be-tuscio-puslapio",
    kodel: "queryPage() eina `seq` MAŽĖJIMO tvarka, o `nextAfterSeq` yra null tiksliai kai kito puslapio nėra",
    async run({ store }) {
      /**
       * ⚠️ DESC GALIOJA TIK ČIA. `list()` toje pačioje saugykloje lieka ASC -
       * tai tikrina scenarijai aukščiau, ir 7.4b paritetas nekeičiamas (#212).
       */
      for (let i = 0; i < 7; i += 1) await store.append(eilute({ details: `nr-${i}` }));

      const matyti = [];
      let cursor = null;
      let puslapiu = 0;

      do {
        const r = await store.queryPage({ limit: 3, afterSeq: cursor });
        puslapiu += 1;

        assert.ok(r.entries.length > 0, "tuščias puslapis neleidžiamas");
        matyti.push(...r.entries.map((e) => e.details));
        cursor = r.nextAfterSeq;
      } while (cursor !== null && puslapiu < 10);

      assert.equal(matyti[0], "nr-6", "naujausias pirmas");
      assert.deepEqual(matyti, ["nr-6", "nr-5", "nr-4", "nr-3", "nr-2", "nr-1", "nr-0"]);
      assert.equal(puslapiu, 3, "7 įrašai po 3 = 3 puslapiai, be ketvirto tuščio");

      /** ASC kelias nepaliestas. */
      assert.equal((await store.list()).entries[0].details, "nr-0", "`list()` lieka ASC");
    },
  },
  {
    id: "lygiagretus-insert-ir-delete-tarp-puslapiu",
    kodel: "pradinio rinkinio įrašai grąžinami LYGIAI KARTĄ, nors tarp puslapių įterpiama IR trinama",
    async run({ store }) {
      /**
       * ⚠️ DU PRIEŠINGI GEDIMO REŽIMAI, TODĖL DU VEIKSMAI.
       *
       * `OFFSET` su `seq DESC`:
       *   INSERT priekyje → viskas pasislenka, ir puslapis 2 grąžina jau matytus
       *                     įrašus (DUBLIKATAI);
       *   DELETE lange    → rinkinys trumpėja, langas slenka atgal, ir dalis
       *                     įrašų PRALEIDŽIAMA.
       *
       * Vien INSERT scenarijus pagautų tik pirmąjį. Keyset kursorius abu
       * išsprendžia, nes riba yra `seq`, ne pozicija.
       */
      const pradiniai = [];
      for (let i = 0; i < 9; i += 1) {
        pradiniai.push(await store.append(eilute({ details: `pradinis-${i}`, subjectId: `s-${i}` })));
      }

      const matyti = [];
      let cursor = null;
      let zingsnis = 0;

      do {
        const r = await store.queryPage({ limit: 2, afterSeq: cursor });
        matyti.push(...r.entries.map((e) => e.details));
        cursor = r.nextAfterSeq;
        zingsnis += 1;

        if (zingsnis === 1) {
          /** INSERT PRIEKYJE: nauji gauna didesnį `seq` ir lieka UŽ kursoriaus. */
          for (let i = 0; i < 3; i += 1) await store.append(eilute({ details: `naujas-${i}` }));
        }

        if (zingsnis === 2) {
          /** DELETE KURSORIAUS LANGE: dar nepasiektas įrašas dingsta. */
          await store.removeBySubject("s-1");
        }
      } while (cursor !== null && zingsnis < 20);

      /** Nė vieno dublikato - tai griūtų su OFFSET po INSERT. */
      assert.equal(new Set(matyti).size, matyti.length, `dublikatai: ${matyti.join(",")}`);

      /** Nauji įrašai į pradinį traversalą NEPATENKA. */
      assert.ok(!matyti.some((d) => d.startsWith("naujas-")), "nauji įrašai neturi patekti");

      /**
       * Visi pradiniai grąžinti lygiai kartą, IŠSKYRUS sąmoningai ištrintą.
       * Ištrintasis - `pradinis-1`; jis buvo dar nepasiektas, tad jo nebūti YRA
       * teisingas rezultatas, o ne praleidimas.
       */
      const laukiami = pradiniai
        .map((e) => e.details)
        .filter((d) => d !== "pradinis-1")
        .sort();

      assert.deepEqual(
        matyti.filter((d) => d.startsWith("pradinis-")).sort(),
        laukiami,
        "kiekvienas neištrintas pradinis įrašas privalo būti grąžintas lygiai kartą"
      );
    },
  },
  {
    id: "kursorius-vienodi-timestamp",
    kodel: "VIENU MOMENTU įrašytos eilutės puslapiuojamos teisingai - `seq`, ne `timestamp`",
    async run({ store, vienuMomentu }) {
      /**
       * ⚠️ ŠIS SCENARIJUS YRA #212 „ordering-key collision" REIKALAVIMAS.
       *
       * Ankstesnis tvarkos scenarijus tikrina `list()` (ASC) - kursoriaus jis
       * neliečia. Čia tos pačios vienoje transakcijoje įrašytos eilutės, kurių
       * `timestamp` SUTAMPA, puslapiuojamos per `queryPage()`.
       *
       * ⚠️ `Date.now()` mock'as čia netiktų: postgres pusėje laiko autoritetas
       * yra DB (`DEFAULT now()`), tad vienodus laikus sukuria transakcija, ne
       * proceso laikrodis. Todėl naudojamas adapterio `vienuMomentu`.
       */
      const zymos = ["a", "b", "c", "d", "e"];
      await vienuMomentu(zymos.map((z) => eilute({ details: z })));

      /** Prielaida: laikai realiai sutampa - kitaip scenarijus tikrintų ne tai. */
      const { entries: visi } = await store.list();
      assert.equal(
        new Set(visi.map((e) => e.timestamp)).size,
        1,
        "prielaida: vienoje transakcijoje visi `timestamp` vienodi"
      );

      const matyti = [];
      let cursor = null;
      let puslapiu = 0;

      do {
        const r = await store.queryPage({ limit: 2, afterSeq: cursor });
        matyti.push(...r.entries.map((e) => e.details));
        cursor = r.nextAfterSeq;
        puslapiu += 1;
      } while (cursor !== null && puslapiu < 10);

      assert.equal(new Set(matyti).size, matyti.length, "vienodi laikai negali duoti dublikatų");
      assert.deepEqual(
        matyti,
        ["e", "d", "c", "b", "a"],
        "tvarka apibrėžta `seq`, nors `timestamp` visoms eilutėms vienodas"
      );
    },
  },
  {
    id: "kursorius-filtrai-komponuojasi",
    kodel: "filtrai veikia KARTU viename užklausos kelyje, ne vienas kitą pakeisdami",
    async run({ store }) {
      await store.append(eilute({ event: "LOGIN_SUCCESS", requestId: "req-a", subjectId: "pseudo-1" }));
      await store.append(eilute({ event: "LOGIN_SUCCESS", requestId: "req-b", subjectId: "pseudo-1" }));
      await store.append(eilute({ event: "LOGIN_FAILED", requestId: "req-a", subjectId: "pseudo-1" }));
      await store.append(eilute({ event: "LOGIN_SUCCESS", requestId: "req-a", subjectId: "pseudo-2" }));

      /** Trys filtrai vienu metu - #212 reikalauja bent `job_id` + du kitus. */
      const r = await store.queryPage({
        limit: 50,
        action: "LOGIN_SUCCESS",
        requestId: "req-a",
        subjectIds: ["pseudo-1"],
      });

      assert.equal(r.entries.length, 1, "visi trys filtrai privalo susikirsti, ne pakeisti vienas kitą");
      assert.equal(r.entries[0].event, "LOGIN_SUCCESS");
      assert.equal(r.entries[0].requestId, "req-a");
      assert.equal(r.entries[0].subjectId, "pseudo-1");
    },
  },
  {
    id: "kursorius-fan-out-aibe",
    kodel: "subjectIds aibė atrenka VISUS jos narius vienu predikatu",
    async run({ store }) {
      /**
       * Rotavus raktą tas pats job'as skirtingose generacijose turi skirtingą
       * `subject_id`. Paieška privalo rasti abu - vienu set-based predikatu.
       */
      await store.append(eilute({ subjectId: "generacija-A", details: "senas" }));
      await store.append(eilute({ subjectId: "generacija-B", details: "naujas" }));
      await store.append(eilute({ subjectId: "kitas-subjektas", details: "svetimas" }));

      const r = await store.queryPage({ limit: 50, subjectIds: ["generacija-A", "generacija-B"] });

      assert.deepEqual(
        r.entries.map((e) => e.details).sort(),
        ["naujas", "senas"],
        "abi generacijos randamos, svetimas subjektas - ne"
      );
    },
  },
  {
    id: "trynimas-per-kelias-generacijas",
    kodel: "removeBySubject priima MASYVĄ ir pašalina visas generacijas vienu kartu",
    async run({ store }) {
      await store.append(eilute({ subjectId: "gen-A" }));
      await store.append(eilute({ subjectId: "gen-B" }));
      await store.append(eilute({ subjectId: "gen-C-kito-jobo" }));

      assert.equal(await store.removeBySubject(["gen-A", "gen-B"]), 2);

      const { entries } = await store.list();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].subjectId, "gen-C-kito-jobo", "svetimo subjekto liesti negalima");
    },
  },
  {
    id: "valymas",
    kodel: "clear() ištuština žurnalą abiejuose backend'uose",
    async run({ store }) {
      await store.append(eilute());
      await store.append(eilute());

      await store.clear();

      assert.equal((await store.list()).total, 0);
    },
  },
  {
    id: "zondas",
    kodel: "probe() grąžina true veikiančiai saugyklai",
    async run({ store }) {
      assert.equal(await store.probe(), true);
    },
  },
  {
    id: "retencija-salina-tik-pries-cutoff",
    kodel: "purgeExpired() riba reiškia TĄ PATĮ abiejuose backend'uose (#213)",
    async run({ store }) {
      await store.append(eilute());
      await store.append(eilute());

      /**
       * ⚠️ Praeities riba negali pašalinti nieko. Backend'as, kuris čia ištrina,
       * traktuoja `cutoff` kaip „viską iki dabar" - ir tyliai naikintų šviežius
       * įrašus.
       */
      const praeitis = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      assert.equal(await store.purgeExpired(praeitis, 100), 0, "praeities riba nešalina nieko");
      assert.equal((await store.list()).total, 2);

      const ateitis = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      assert.equal(await store.purgeExpired(ateitis, 100), 2, "riba po įrašų - abu pašalinami");
      assert.equal((await store.list()).total, 0);
    },
  },
  {
    id: "retencija-gerbia-batch-limita",
    kodel: "purgeExpired() limit riboja VIENĄ kvietimą abiejuose backend'uose (#213)",
    async run({ store }) {
      for (let i = 0; i < 3; i += 1) await store.append(eilute());

      const ateitis = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      assert.equal(await store.purgeExpired(ateitis, 2), 2, "ne daugiau nei limitas");
      assert.equal(await store.purgeExpired(ateitis, 2), 1, "likutis");
      assert.equal(await store.purgeExpired(ateitis, 2), 0, "aibė išsemta");
    },
  },
  {
    id: "privacy-purge-isvalo-viska",
    kodel: "purgeAllForPrivacy() yra teisėtas starto kelias abiejuose backend'uose (#213)",
    async run({ store }) {
      await store.append(eilute());
      await store.append(eilute());

      assert.equal(await store.purgeAllForPrivacy(), 2, "grąžinamas pašalintų kiekis");
      assert.equal((await store.list()).total, 0);

      /** Idempotentiška: pakartotinis startas su ta pačia vėliava nekrenta. */
      assert.equal(await store.purgeAllForPrivacy(), 0);
    },
  },
];

async function paleisti(ctx, pavadinimas) {
  const rezultatai = [];

  for (const scenarijus of SCENARIJAI) {
    /** Kiekvienas scenarijus pradeda nuo švaraus žurnalo - kitaip `total` priklausytų nuo eiliškumo. */
    await ctx.store.clear();

    try {
      await scenarijus.run(ctx);
    } catch (klaida) {
      klaida.message = `[${pavadinimas}/${scenarijus.id}] ${klaida.message}`;
      throw klaida;
    }

    rezultatai.push({ id: scenarijus.id });
  }

  return rezultatai;
}

async function nuleistiDb(dbName) {
  const admin = new Pool({ connectionString: adminDatabaseUrl() });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

const ADAPTERIAI = [
  {
    name: "memory",
    skip: false,
    async setup() {
      return {
        store: memoryStore,
        /**
         * ⚠️ „VIENAS MOMENTAS" REIŠKIA VIENODĄ `timestamp`, ne tik nuoseklų įrašymą.
         *
         * PostgreSQL pusėje tai duoda transakcija: `now()` visoms eilutėms
         * grąžina tą patį momentą. Atmintyje ekvivalentas - ta pati laiko žyma
         * visoms eilutėms. Anksčiau čia buvo tiesiog ciklas, tad laikai
         * skirdavosi, ir tvarkos scenarijus atmintyje tikrindavo silpnesnę
         * sąlygą nei postgres.
         */
        vienuMomentu: async (eilutes) => {
          const momentas = new Date().toISOString();
          for (const e of eilutes) await memoryStore.append({ ...e, timestamp: momentas });
        },
        cleanup: async () => memoryStore.clear(),
      };
    },
  },
  {
    name: "postgres",
    skip: skipWithoutPostgres(),
    async setup() {
      /**
       * ⚠️ RESURSAI REGISTRUOJAMI IŠ KARTO PO SUKŪRIMO. Jei `setup()` kristų
       * prieš grąžindamas kontekstą, kvietėjo `finally` niekada neįvyktų.
       */
      const resursai = sukurtiResursuKruva();
      try {
        const url = testDatabaseUrl("audit_contract");
        const dbName = new URL(url).pathname.slice(1);
        const admin = new Pool({ connectionString: adminDatabaseUrl() });
        const uzdarytiAdmin = resursai.registruoti("admin pool", () => admin.end());
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${dbName}"`);
        resursai.registruoti("laikina DB", () => nuleistiDb(dbName));
        await uzdarytiAdmin();

        execFileSync("npx", ["node-pg-migrate", "up"], {
          cwd: path.resolve(__dirname, ".."),
          env: { ...process.env, DATABASE_URL: url },
          stdio: ["ignore", "pipe", "pipe"],
        });

        const pool = new Pool({ connectionString: url });
        resursai.registruoti("darbinis pool", () => pool.end());

        return {
          store: createPostgresStore(pool, { hashKeyId: HASH_KEY_ID }),

          /**
           * ⚠️ VIENA TRANSAKCIJA - BŪTENT TAI, KAS SULAUŽO `timestamp` TVARKĄ.
           *
           * Viduje `now()` visoms eilutėms grąžina TĄ PATĮ momentą. Store'as
           * gauna `client`, ne `pool`: jis naudoja tik `.query()`, tad klientas
           * tinka be jokių pakeitimų, o eilutės realiai patenka į vieną
           * transakciją.
           */
          vienuMomentu: async (eilutes) => {
            const client = await pool.connect();
            try {
              await client.query("BEGIN");
              const transakcijosStore = createPostgresStore(client, { hashKeyId: HASH_KEY_ID });
              for (const e of eilutes) await transakcijosStore.append(e);
              await client.query("COMMIT");
            } catch (klaida) {
              await client.query("ROLLBACK").catch(() => {});
              throw klaida;
            } finally {
              client.release();
            }
          },

          cleanup: async () => resursai.isvalyti(),
        };
      } catch (klaida) {
        await resursai.isvalyti(klaida);
        throw klaida;
      }
    },
  },
];

for (const adapter of ADAPTERIAI) {
  test(
    `AUDITO KONTRAKTAS: ${adapter.name} vykdo bendrą scenarijų rinkinį`,
    { skip: adapter.skip },
    async () => {
      const ctx = await adapter.setup();
      try {
        const rezultatai = await paleisti(ctx, adapter.name);

        /**
         * ⚠️ PILNUMAS TIKRINAMAS PAGAL `id`, NE PAGAL SKAIČIŲ: skaičiaus patikra
         * praeitų pakeitus vieną scenarijų kitu.
         */
        assert.deepEqual(
          rezultatai.map((r) => r.id),
          SCENARIJAI.map((s) => s.id),
          `${adapter.name} privalo įvykdyti VISUS bendrus scenarijus`
        );
      } finally {
        await ctx.cleanup();
      }
    }
  );
}

test("KONTRAKTAS: abu backend'ai deklaruoja tą patį viešą paviršių", () => {
  /**
   * ⚠️ SCENARIJAI TIKRINA ELGESĮ, BET NE METODO BUVIMĄ. Backend'as, praradęs
   * `close()`, scenarijų rinkinio nesulaužytų, o pool'as liktų neuždarytas.
   */
  const pgStore = createPostgresStore({ query: async () => ({ rows: [], rowCount: 0 }) }, {
    hashKeyId: HASH_KEY_ID,
  });

  const KONTRAKTAS = [
    "append",
    "list",
    "queryPage",
    "removeBySubject",
    "countBySubject",
    "usedGenerations",
    "clear",
    "probe",
    "close",
  ];

  for (const metodas of KONTRAKTAS) {
    assert.equal(typeof memoryStore[metodas], "function", `memory: trūksta ${metodas}`);
    assert.equal(typeof pgStore[metodas], "function", `postgres: trūksta ${metodas}`);
  }

  assert.equal(memoryStore.backend, "memory");
  assert.equal(pgStore.backend, "postgres");
});

test("KONTRAKTAS: scenarijų sąrašas yra VIENAS ir be dublikatų", () => {
  const ids = SCENARIJAI.map((s) => s.id);

  assert.equal(new Set(ids).size, ids.length, "dublikuotas id paslėptų vieną scenarijų");
  assert.ok(ids.length >= 21, "rinkinys negali tyliai susitraukti");

  for (const s of SCENARIJAI) {
    assert.ok(s.kodel && s.kodel.length > 10, `${s.id}: scenarijus be paaiškinimo`);
  }
});
