const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  GALIOJANTYS,
  ATMETAMI,
  NUOSTOLINGI,
  BLOGI_RAKTAI,
  operacijosSuRaktu,
  tapatybe,
} = require("./artifactStoreScenarios");

/**
 * `ArtifactStore` KONTRAKTO RINKINYS - VIENAS, VISIEMS BACKEND'AMS (#157, PR-2).
 *
 * ⚠️ ŠIS FAILAS YRA VARTAI. S3 ir `inline` implementacijos privalo praeiti jį
 * NEKEIČIAMOS: jei kuri nors pareikalautų išimties, tai reiškia, kad kontraktas
 * neapibrėžtas, o ne kad testas per griežtas.
 *
 * ⚠️ NĖ VIENAS TVIRTINIMAS NEREMIASI SAUGYKLOS RŪŠIMI. Nėra prielaidų, kad
 * rašymas iškart matomas listing'e, kad `head` skaito failą, kad raktas yra
 * kelias ar kad klaida ateina sinchroniškai. Tikrinama tik tai, ką kontraktas
 * ĮSIPAREIGOJA.
 *
 * ⚠️ RAKTŲ FORMĄ DUODA BACKEND'AS, NE RINKINYS.
 *
 * Rinkinys, gaminantis `results/<...>.json`, būtų įkodavęs KELIO formą — o ji
 * teisinga tik saugykloms, adresuojančioms objektus keliu. `inline` eilutė
 * adresuojama job'o tapatybe ir turi FK į `jobs`, tad išgalvotas raktas ten
 * apskritai neįrašomas. Todėl kiekvienas backend'as pateikia savo `raktas()`, o
 * kontraktas lieka apie ELGESĮ, ne apie adresavimo schemą.
 *
 * ⚠️ EXTERNAL PAKOPA — KLASĖS, NE BACKEND'O SKIRTUMAS.
 *
 * Dalis #157 garantijų kalba apie IŠORINĮ objektą: kad `reference` persistinama,
 * kad du bandymai turi atskirus objektus, kad vieno šalinimas neliečia kito.
 * `inline` atveju jos neturi prasmės — ten objekto nėra, adresas yra job'o
 * tapatybė, ir du bandymai rašo ta pačia vieta TEISĖTAI.
 *
 * Todėl fixture deklaruoja `external: true`, ir tos garantijos tikrinamos
 * atskira pakopa. Alternatyva (bendras scenarijus su `if backend === ...`) būtų
 * pavertusi vartus sąlyginiais, o būtent to šis rinkinys ir vengia.
 *
 * ⚠️ BE ŠIOS PAKOPOS attempt-uniqueness garantija liktų BE NAMŲ: bendras
 * rinkinys jos tikrinti negali, o vienintelis ją liečiantis testas būtų S3
 * specifinis — t. y. PR-4 reikalavimas gyventų tik plane.
 *
 * @param {string} vardas backend'o vardas ataskaitai
 * @param {() => Promise<{saugykla: object, raktas: Function, external?: boolean, isvalyti?: Function}>} paruosti
 */
function paleistiKontrakta(vardas, paruosti) {
  test(`ArtifactStore kontraktas: ${vardas}`, { timeout: 120000 }, async (t) => {
    const { saugykla, raktas, nuoroda, nepriklausomas, isvalyti } = await paruosti();

    assert.equal(typeof raktas, "function", "backend'as privalo pateikti `raktas()` gamyklą");

    /**
     * ⚠️ BACKEND'AS DEKLARUOJA SAVO SEMANTIKĄ, O RINKINYS JĄ TIKRINA (Codex, #290).
     *
     * Tikrinti tik TIPĄ („`reference` yra `null` ARBA adresas", „`nepriklausomas`
     * yra loginė reikšmė") reiškia, kad backend'o regresija lieka žalia: inline,
     * pradėjęs grąžinti `job_id` kaip nuorodą, praeitų vartus, o pirmas kvietėjas,
     * kuris ją persistintų, gautų `23514`. Lygiai taip inline, pradėjęs skelbti
     * `nepriklausomas: true`, priverstų PR-7 ataskaitą skaičiuoti iš to paties
     * `payload` išvestą sumą kaip nepriklausomą įrodymą.
     *
     * Todėl fixture deklaruoja LAUKIAMĄ reikšmę, o ne rinkinys spėja.
     */
    assert.ok(
      nuoroda === "null" || nuoroda === "raktas",
      "fixture privalo deklaruoti `nuoroda`: null arba raktas"
    );
    assert.equal(
      typeof nepriklausomas,
      "boolean",
      "fixture privalo deklaruoti, ar `verify()` palyginimas NEPRIKLAUSOMAS"
    );

    /** EXTERNAL pakopa yra to paties fakto pasekmė, ne atskiras jungiklis. */
    const external = nuoroda === "raktas";

    t.after(async () => {
      if (isvalyti) await isvalyti();
    });

    /* ═══ 1. ROUND-TRIP IŠTIKIMYBĖ ═══ */

    await t.test("put -> read išlaiko kanoninę tapatybę", async () => {
      for (const scenarijus of GALIOJANTYS) {
        const k = await raktas();
        await saugykla.put(k, scenarijus.reiksme);
        const grazinta = await saugykla.read(k);

        assert.equal(
          tapatybe(grazinta),
          tapatybe(scenarijus.reiksme),
          `round-trip pakeitė tapatybę: ${scenarijus.vardas}`
        );
      }
    });

    await t.test("tapatybė NEPRIKLAUSO nuo raktų tvarkos, bet PRIKLAUSO nuo masyvo", async () => {
      for (const scenarijus of GALIOJANTYS) {
        if (scenarijus.tapatuSu) {
          const a = await raktas();
          const b = await raktas();
          await saugykla.put(a, scenarijus.reiksme);
          await saugykla.put(b, scenarijus.tapatuSu);

          assert.equal(
            tapatybe(await saugykla.read(a)),
            tapatybe(await saugykla.read(b)),
            `skirtinga raktų tvarka privalo duoti TĄ PAČIĄ tapatybę: ${scenarijus.vardas}`
          );
        }

        if (scenarijus.skiriasiNuo) {
          const a = await raktas();
          const b = await raktas();
          await saugykla.put(a, scenarijus.reiksme);
          await saugykla.put(b, scenarijus.skiriasiNuo);

          assert.notEqual(
            tapatybe(await saugykla.read(a)),
            tapatybe(await saugykla.read(b)),
            `masyvo tvarka privalo LIKTI reikšminga: ${scenarijus.vardas}`
          );
        }
      }
    });

    /* ═══ 2. `put` GRĄŽINAMI METADUOMENYS ═══ */

    await t.test("put grąžina `bytes` ir `checksum`, sutampančius su kanonine eilute", async () => {
      const k = await raktas();
      const reiksme = { text: "kvitas", segments: [1, 2] };

      const rezultatas = await saugykla.put(k, reiksme);
      const kanonine = tapatybe(reiksme);

      assert.equal(rezultatas.key, k, "adresas grąžinamas nepakeistas");

      /**
       * ⚠️ `reference` YRA TAI, KAS PERSISTINAMA, IR JI GALI BŪTI `null`.
       *
       * Išorinėse saugyklose ji sutampa su adresu; `inline` eilutėje
       * `storage_key` PRIVALO būti `NULL` (PR-1 invariantas), tad ten `reference`
       * yra `null`. Kontraktas tikrina TIK tai, kad reikšmė yra viena iš dviejų
       * teisėtų formų — kitaip inline implementacija išgalvotų sentinelį, o
       * pirmas kvietėjas, kuris jį persistintų, gautų `23514`.
       */
      assert.equal(
        rezultatas.reference,
        nuoroda === "null" ? null : k,
        `\`reference\` privalo atitikti deklaruotą semantiką (${nuoroda})`
      );
      assert.equal(
        rezultatas.checksum,
        crypto.createHash("sha256").update(kanonine, "utf8").digest("hex"),
        "checksum privalo būti KANONINĖS EILUTĖS suma, ne saugyklos baitų"
      );
      assert.equal(
        rezultatas.bytes,
        Buffer.byteLength(kanonine, "utf8"),
        "`bytes` privalo matuoti tą pačią kanoninę eilutę"
      );
      assert.ok(rezultatas.bytes > 0, "nulinis dydis reikštų nutrauktą rašymą");
    });

    await t.test("kvitas aprašo TAI, KAS ĮRAŠYTA — ne antrą serializaciją", async () => {
      /**
       * ⚠️ RIBA SKAIČIUOJA KVITĄ, IMPLEMENTACIJA NEBESERIALIZUOJA IŠ NAUJO
       * (Codex, #290).
       *
       * Jei implementacija pati dar kartą paverstų PRADINĘ reikšmę baitais,
       * tarp kvito ir įrašymo liktų langas: reikšmė gali pasikeisti (getter'is,
       * `toJSON` su būsena, kitas gijos darbas), ir tada saugykloje gultų viena,
       * o `checksum` aprašytų kitą. Tai vienintelė vieta, kur suma gali
       * apibūdinti NE TAI, kas įrašyta — o būtent ja remiasi 7.6 vientisumo
       * patikra ir PR-4 idempotencijos fast-path.
       *
       * ⚠️ REIKŠMĖ SVYRUOJA TIK PO DVIEJŲ SKAITYMŲ. Riba reikšmę perbėga du
       * kartus (kanonizacija + inline stabilumo modelis), tad svyravimas nuo
       * PIRMO skaitymo būtų atmestas dar ties riba ir šito lango neparodytų.
       */
      /**
       * ⚠️ RIBOS SKAITYMŲ SKAIČIUS IŠMATUOJAMAS, NE ĮKODUOJAMAS.
       *
       * Riba reikšmę perbėga kelis kartus (kanonizacija + inline stabilumo
       * modelis), ir tas skaičius yra jos vidinis reikalas. Įrašytas konstanta,
       * jis pasentų tyliai; išmatuotas — testas persikalibruoja pats, o
       * tvirtinimas lieka apie tai, kas iš tikrųjų svarbu: implementacija
       * NEPRIDEDA nė vieno skaitymo.
       */
      const { paruostiReiksme } = require("../../utils/artifactStore/validation");

      let ribosSkaitymai = 0;
      paruostiReiksme({
        get text() {
          ribosSkaitymai += 1;
          return "pastovi";
        },
      });

      let kvietimai = 0;
      const nestabili = {
        get text() {
          kvietimai += 1;
          return kvietimai <= ribosSkaitymai ? "pirma" : "antra";
        },
      };

      const k = await raktas();
      const kvitas = await saugykla.put(k, nestabili);

      assert.equal(
        kvietimai,
        ribosSkaitymai,
        "implementacija reikšmę perskaitė DAR KARTĄ — būtent tame lange kvitas ir turinys išsiskiria"
      );

      const perskaityta = tapatybe(await saugykla.read(k));
      assert.equal(
        crypto.createHash("sha256").update(perskaityta, "utf8").digest("hex"),
        kvitas.checksum,
        "`checksum` privalo aprašyti ĮRAŠYTĄ turinį, ne tarpinę reikšmės būseną"
      );
      assert.equal(Buffer.byteLength(perskaityta, "utf8"), kvitas.bytes, "`bytes` — to paties turinio");

      const patvirtinimas = await saugykla.verify(k, { bytes: kvitas.bytes, checksum: kvitas.checksum });
      assert.equal(patvirtinimas.ok, true, "saugykla privalo patvirtinti savo pačios kvitą");
    });

    /* ═══ 3. `head` ═══ */

    await t.test("head: esantis objektas grąžina dydį, nesantis - `null`", async () => {
      const k = await raktas();
      const { bytes } = await saugykla.put(k, { text: "yra" });

      const galva = await saugykla.head(k);
      assert.ok(galva, "esantis objektas privalo turėti metaduomenis");
      assert.equal(galva.exists, true);
      assert.equal(galva.bytes, bytes, "dydis privalo sutapti su `put` grąžintu");

      assert.equal(await saugykla.head(await raktas()), null, "nesantis objektas -> `null`, ne klaida");
    });

    /* ═══ 4. `verify` ═══ */

    await t.test("verify: sutampantys metaduomenys -> ok, nesutampantys -> ne ok", async () => {
      const k = await raktas();
      const { bytes, checksum } = await saugykla.put(k, { text: "vientisumas" });

      const patvirtinimas = await saugykla.verify(k, { bytes, checksum });
      assert.equal(patvirtinimas.ok, true, "teisingi lūkesčiai");

      /**
       * ⚠️ VIENTISUMO PATIKRA NĖRA VIENODAI STIPRI VISUOSE BACKEND'UOSE.
       *
       * Kur metaduomenys persistinami ATSKIRAI (external), `verify()` lygina
       * objektą su nepriklausomu įrašu. Kur jų nėra (`inline`), jis gali tik
       * perskaičiuoti iš to paties turinio — t. y. lyginti reikšmę su savimi.
       * Abu atvejai teisėti, bet jie NE tas pats, tad kontraktas reikalauja, kad
       * skirtumas būtų PASAKYTAS, o ne numanomas.
       */
      assert.equal(
        patvirtinimas.nepriklausomas,
        nepriklausomas,
        "`verify()` privalo pasakyti TIKSLIAI tai, ką backend'as gali įrodyti"
      );
      assert.equal(
        (await saugykla.verify(k, { bytes: bytes + 1, checksum })).ok,
        false,
        "neteisingas dydis privalo būti pastebėtas"
      );
      assert.equal(
        (await saugykla.verify(k, { bytes, checksum: "f".repeat(64) })).ok,
        false,
        "neteisinga suma privalo būti pastebėta"
      );
      assert.equal(
        (await saugykla.verify(await raktas(), { bytes: 1, checksum: "f".repeat(64) })).ok,
        false,
        "nesantis objektas -> ne ok, ne klaida: kvietėjas nusprendžia, ką daryti"
      );
    });

    await t.test("verify: laukiami metaduomenys ateina IŠ DB, tad tipas gali būti eilutė", async () => {
      /**
       * ⚠️ `bigint` STULPELIS PER `node-postgres` GRĮŽTA EILUTE (Codex P1, #290).
       *
       * `job_results.bytes` yra `bigint`, o `pg` tokius stulpelius grąžina kaip
       * eilutes (64 bitai netelpa į JS skaičių saugiai). Griežtas `===` tada
       * lygina `"12"` su `12`, ir KIEKVIENAS DB paremtas artefaktas atrodytų
       * sugadintas — 7.6 restore verifikacija taptų beverte būtent tada, kai ja
       * remiamasi.
       *
       * ⚠️ ČIA TIPAS IMITUOJAMAS. Kad jis tikrai toks ateina iš `bigint`
       * stulpelio, matuoja `artifactStoreVerifyMetadata.integration` prieš tikrą
       * PostgreSQL; šis tvirtinimas gina kontraktą kiekvienam backend'ui.
       */
      const k = await raktas();
      const { bytes, checksum } = await saugykla.put(k, { text: "iš DB" });

      assert.equal(
        (await saugykla.verify(k, { bytes: String(bytes), checksum })).ok,
        true,
        "`bytes` eilute privalo reikšti tą patį, ką skaičiumi"
      );

      assert.equal(
        (await saugykla.verify(k, { bytes: String(bytes + 1), checksum })).ok,
        false,
        "KONTROLĖ: normalizavimas neturi paversti palyginimo visada teigiamu"
      );
    });

    await t.test("verify: nesančio objekto forma PILNA, ne dalinė", async () => {
      /**
       * ⚠️ TRŪKSTAMAS LAUKAS YRA TREČIA BŪSENA (Codex, #290).
       *
       * PR-7 ataskaita eilutes skirsto pagal `nepriklausomas`, ne pagal `ok`.
       * Jei nesančiam objektui tas laukas negrįžta, atsiranda `undefined` —
       * ir „nepriklausomai nepatvirtinta" tyliai susilieja su „patvirtinta
       * priklausomai". Todėl kontraktas reikalauja VISŲ laukų abiem atvejais.
       */
      const verdiktas = await saugykla.verify(await raktas(), { bytes: 1, checksum: "a".repeat(64) });

      assert.deepEqual(
        Object.keys(verdiktas).sort(),
        ["bytes", "checksum", "exists", "nepriklausomas", "ok"],
        "nesančio objekto verdiktas privalo turėti TĄ PATĮ laukų rinkinį"
      );
      assert.equal(verdiktas.exists, false);
      assert.equal(verdiktas.ok, false);
      assert.equal(verdiktas.bytes, null);
      assert.equal(verdiktas.checksum, null);
      assert.equal(
        verdiktas.nepriklausomas,
        nepriklausomas,
        "vėliava privalo būti ir tada, kai objekto nėra — ir ta pati"
      );
    });

    /* ═══ 5. `delete` ═══ */

    /**
     * ⚠️ KAS KVIEČIA `delete()`, KAI `reference` YRA `null` (#157, PR-2).
     *
     * Erasure kelias eina per `job_results.storage_key`: yra nuoroda - yra ką
     * trinti saugykloje. `inline` eilutėje `storage_key` yra `NULL`, tad ATSKIRO
     * trynimo kvietimo NĖRA IR NEBUS: turinys gyvena toje pačioje eilutėje ir
     * dingsta kartu su ja (`job_results.job_id` -> `jobs(id)` su `ON DELETE
     * CASCADE`). Adreso niekas neatkurs, nes jo niekas nepersistino - ir nereikia.
     *
     * ⚠️ BET `delete()` PRIVALO VEIKTI VISUOSE BACKEND'UOSE. Kontraktas nedaro
     * išimties „inline gali nepalaikyti": implementacija, kuri jo nepalaiko,
     * anksčiau ar vėliau bus iškviesta per bendrą kelią, ir tada tylus no-op
     * atrodys kaip sėkmingas ištrynimas. Todėl žemiau tas pats scenarijus
     * vykdomas VISIEMS - skiriasi tik tai, kas jį kviečia produkcijoje.
     */
    await t.test("delete: `true` pašalinus, `false` kai nebuvo - be klaidos", async () => {
      const k = await raktas();
      await saugykla.put(k, { text: "trinama" });

      assert.equal(await saugykla.delete(k), true, "pašalinimas grąžina `true`");
      assert.equal(await saugykla.delete(k), false, "pakartotinis - `false`, NE klaida");
      assert.equal(await saugykla.head(k), null, "po trynimo metaduomenų nebėra");
    });

    /* ═══ 6. `read` NESANČIO ═══ */

    await t.test("read: nesantis objektas -> tipizuota klaida", async () => {
      await assert.rejects(
        async () => saugykla.read(await raktas()),
        (klaida) => klaida.code === "ARTIFACT_NOT_FOUND",
        "trukstamas objektas privalo skirtis nuo sugedusio: kvietejas elgiasi skirtingai"
      );
    });

    /* ═══ 7. `readStream` ═══ */

    await t.test("readStream duoda TĄ PAČIĄ reikšmę kaip `read`", async () => {
      const k = await raktas();
      const reiksme = { text: "srautas", segments: Array.from({ length: 100 }, (_, i) => i) };
      const { bytes } = await saugykla.put(k, reiksme);

      const gabalai = [];
      for await (const gabalas of await saugykla.readStream(k)) gabalai.push(gabalas);
      const surinkta = Buffer.concat(gabalai.map((g) => Buffer.from(g)));

      assert.equal(surinkta.byteLength, bytes, "srauto dydis privalo sutapti su deklaruotu");
      assert.equal(
        tapatybe(JSON.parse(surinkta.toString("utf8"))),
        tapatybe(reiksme),
        "srautu perskaityta reikšmė privalo būti ta pati"
      );
    });

    /* ═══ 8. ATMETAMOS REIKŠMĖS ═══ */

    await t.test("kontraktas atmeta reikšmes, kurių ne visi backend'ai gali išsaugoti", async () => {
      for (const scenarijus of ATMETAMI) {
        await assert.rejects(
          async () => saugykla.put(await raktas(), scenarijus.reiksme),
          (klaida) => klaida.code === "ARTIFACT_VALUE_UNSUPPORTED",
          `privalėjo būti atmesta ties riba: ${scenarijus.vardas}`
        );
      }
    });

    await t.test("nuostolingos reikšmės prarandamos VIENODAI, o ne skirtingai", async () => {
      /**
       * ⚠️ TIKRINAMAS PARITETAS, NE ATMETIMAS. Kanoninis autoritetas funkcijas ir
       * `undefined` numeta pats; kontraktas to nekeičia, bet PRIVALO garantuoti,
       * kad visi backend'ai praranda tą patį ir grąžina tą pačią tapatybę.
       */
      for (const scenarijus of NUOSTOLINGI) {
        const k = await raktas();
        await saugykla.put(k, scenarijus.reiksme);

        assert.equal(
          tapatybe(await saugykla.read(k)),
          tapatybe(scenarijus.virsta),
          `praradimas nesutampa su išmatuotu: ${scenarijus.vardas}`
        );
      }
    });

    /* ═══ 9. ATMETAMI RAKTAI ═══ */

    await t.test("kontraktas atmeta blogus raktus VISOSE operacijose", async () => {
      /**
       * ⚠️ OPERACIJŲ SĄRAŠAS IŠVEDAMAS IŠ SAUGYKLOS PAVIRŠIAUS (Codex, #290).
       *
       * Ranka surašytas jis jau buvo praleidęs `readStream`. Nauja operacija be
       * matricos eilutės dabar sustabdo rinkinį su vardu — o ne praslysta.
       */
      const operacijos = operacijosSuRaktu(saugykla);
      assert.ok(operacijos.length >= 6, `raktų matrica privalo dengti visą paviršių: ${operacijos.length}`);

      for (const scenarijus of BLOGI_RAKTAI) {
        for (const [operacija, veiksmas] of operacijos) {
          await assert.rejects(
            () => veiksmas(scenarijus.raktas),
            (klaida) => klaida.code === "ARTIFACT_KEY_INVALID",
            `${operacija} praleido blogą raktą: ${scenarijus.vardas}`
          );
        }
      }
    });

    await t.test("readStream klaida yra APDOROJAMA, ne tik tipizuota", async () => {
      /**
       * ⚠️ KONTRAKTAS NEŽADA „visada tipizuota" (§12.1).
       *
       * Egzistavimo patikra prieš srautą dažną atvejį paverčia
       * `ARTIFACT_NOT_FOUND`, bet lango neuždaro: objektas gali dingti tarp
       * patikros ir skaitymo. Tikrinama, kad srautas klaidą PRANEŠA — kad
       * kvietėjas turėtų ką apdoroti — o ne kad ji visada ateina prieš srautą.
       */
      const k = await raktas();
      await saugykla.put(k, { text: "dings" });

      const srautas = await saugykla.readStream(k);
      await saugykla.delete(k);

      /**
       * ⚠️ KLAIDA PRIVALO ATEITI PER SRAUTĄ, NE PRO ŠALĮ (CI 33909325226).
       *
       * Pirmoji redakcija tikrino tik „duomenys arba klaida", ir CI parodė, kodėl
       * to nepakanka: `ENOENT` atkeliavo kaip `uncaughtException` — testas krito
       * ne dėl tvirtinimo, o dėl klaidos, kurios niekas nesugavo. Tvirtinimas
       * buvo teisingas, bet nepasiekiamas.
       *
       * Todėl aiškiai fiksuojama, kad neapdorotų klaidų NĖRA: jos arba ateina per
       * `for await`, arba nekyla išvis.
       */
      const nesugautos = [];
      const stebetojas = (e) => nesugautos.push(e);
      process.on("uncaughtException", stebetojas);

      let klaida = null;
      let baitai = 0;
      try {
        for await (const gabalas of srautas) baitai += gabalas.length;
      } catch (e) {
        klaida = e;
      } finally {
        await new Promise((r) => setImmediate(r));
        process.off("uncaughtException", stebetojas);
      }

      assert.deepEqual(
        nesugautos.map((e) => e.code || e.message),
        [],
        "srauto klaida privalo būti SUGAUNAMA, ne virsti `uncaughtException`"
      );

      assert.ok(
        klaida !== null || baitai > 0,
        "srautas privalo arba perduoti duomenis, arba pranešti klaidą — bet ne kabėti tyliai"
      );
    });

    await t.test("adresas, kurio saugykla negalėtų pagaminti, elgiasi kaip NESANTIS", async () => {
      /**
       * ⚠️ VIENODAS ĮĖJIMAS PRIVALO DUOTI VIENODĄ ATSAKYMĄ (Codex, #290).
       *
       * `nesantis` yra galiojantis raktas pagal ribos allowlist'ą, bet jo forma
       * netinka kiekvienam backend'ui: vienur tai paprasčiausiai nesantis
       * objektas, kitur — adresas, kurio saugykla pati niekada nesugalvotų.
       *
       * Kontraktas reikalauja, kad rezultatas būtų TAS PATS: „nėra", ne rakto
       * klaida ir ne saugyklos vidinė klaida. Priešingu atveju tas pats įėjimas
       * vienoje saugykloje būtų `ARTIFACT_NOT_FOUND`, kitoje — žalia DB klaida,
       * ir bendras rinkinys nustotų būti bendras.
       */
      const svetimas = "nesantis";

      assert.equal(await saugykla.head(svetimas), null, "`head` -> `null`");
      assert.equal(await saugykla.delete(svetimas), false, "`delete` -> `false`");
      assert.equal(
        (await saugykla.verify(svetimas, { bytes: 1, checksum: "a".repeat(64) })).ok,
        false,
        "`verify` -> `ok: false`"
      );

      await assert.rejects(
        () => saugykla.read(svetimas),
        (klaida) => klaida.code === "ARTIFACT_NOT_FOUND",
        "`read` -> `ARTIFACT_NOT_FOUND`, ne saugyklos vidinė klaida"
      );
    });

    /* ═══ 10. EXTERNAL PAKOPA ═══ */

    await t.test("EXTERNAL: `reference` yra adresas, ne `null`", { skip: !external }, async () => {
      const k = await raktas();
      const rezultatas = await saugykla.put(k, { text: "nuoroda" });

      assert.equal(
        rezultatas.reference,
        k,
        "išorinė saugykla PRIVALO grąžinti persistinamą nuorodą — be jos `storage_key` liktų tuščias"
      );
    });

    await t.test("EXTERNAL: `head` PREFIKSUI nerodo objekto", { skip: !external }, async () => {
      /**
       * ⚠️ ORPHAN APTIKIMAS APIBRĖŽTAS PER `head` (A3), TAD KLAIDINGAS TEIGIAMAS
       * ČIA UŽMASKUOJA DINGUSĮ ARTEFAKTĄ.
       *
       * Jei saugykla rakto prefiksui grąžina „objektas yra", DB krypties
       * inventorius nusiramins ties eilute, kurios objekto nebėra. Filesystem
       * pusėje prefiksas yra KATALOGAS, kurio `stat()` pavyksta; objektų
       * saugykloje jis paprastai yra tiesiog nesantis raktas.
       *
       * Kontraktas reikalauja to paties atsakymo abiem atvejais: prefiksas nėra
       * objektas.
       */
      const k = await raktas();
      await saugykla.put(k, { text: "gilus" });

      const prefiksas = k.split("/").slice(0, -1).join("/");
      if (prefiksas.length === 0) return;

      assert.equal(
        await saugykla.head(prefiksas),
        null,
        "prefiksas nėra objektas — kitaip orphan patikra nusiramintų be pagrindo"
      );

      await assert.rejects(
        () => saugykla.read(prefiksas),
        (klaida) => klaida.code === "ARTIFACT_NOT_FOUND",
        "ir skaitymas privalo sakyti tą patį"
      );

      assert.equal((await saugykla.verify(prefiksas, { bytes: 1, checksum: "a".repeat(64) })).ok, false);
    });

    await t.test("EXTERNAL: du bandymai su TUO PAČIU turiniu — du atskiri objektai", { skip: !external }, async () => {
      /**
       * ⚠️ TAI PR-4 attempt-uniqueness PAGRINDAS.
       *
       * Jei saugykla tyliai dedupliktuotų pagal turinį (turinio adresavimas
       * „po gaubtu"), du bandymai dalintųsi vienu objektu, ir pralaimėjusiojo
       * cleanup ištrintų laimėtojo duomenis. Čia tikrinama, kad skirtingi
       * adresai lieka NEPRIKLAUSOMI net esant identiškam turiniui.
       */
      const a = await raktas();
      const b = await raktas();
      const reiksme = { text: "tas pats turinys" };

      await saugykla.put(a, reiksme);
      await saugykla.put(b, reiksme);

      assert.notEqual(a, b, "gamykla privalo duoti skirtingus adresus");
      assert.ok(await saugykla.head(a));
      assert.ok(await saugykla.head(b));

      assert.equal(await saugykla.delete(a), true);

      assert.equal(await saugykla.head(a), null, "pašalintas bandymas dingo");
      assert.ok(
        await saugykla.head(b),
        "KITO bandymo objektas privalo LIKTI — kitaip cleanup ištrintų svetimus duomenis"
      );
      assert.equal(
        tapatybe(await saugykla.read(b)),
        tapatybe(reiksme),
        "ir jo turinys nepakitęs"
      );
    });

    /* ═══ 11. KONTROLĖ ═══ */

    await t.test("KONTROLĖ: teisėtas raktas ir reikšmė PRAEINA visose operacijose", async () => {
      /**
       * Be jos 8 ir 9 patikros galėtų būti tenkinamos saugyklos, kuri atmeta
       * VISKĄ - ir kontraktas nieko neįrodytų.
       */
      const k = await raktas();
      const { bytes, checksum } = await saugykla.put(k, { text: "kontrolė" });

      assert.ok((await saugykla.head(k)).exists);
      assert.equal((await saugykla.verify(k, { bytes, checksum })).ok, true);
      assert.equal(tapatybe(await saugykla.read(k)), tapatybe({ text: "kontrolė" }));
      assert.equal(await saugykla.delete(k), true);
    });
  });
}

module.exports = { paleistiKontrakta };
