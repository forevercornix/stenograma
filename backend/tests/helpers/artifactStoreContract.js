const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  GALIOJANTYS,
  ATMETAMI,
  NUOSTOLINGI,
  BLOGI_RAKTAI,
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
    const { saugykla, raktas, external = false, isvalyti } = await paruosti();

    assert.equal(typeof raktas, "function", "backend'as privalo pateikti `raktas()` gamyklą");

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
      assert.ok(
        rezultatas.reference === null || rezultatas.reference === k,
        "`reference` privalo būti arba adresas, arba `null` — jokio sentinelio"
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
        typeof patvirtinimas.nepriklausomas,
        "boolean",
        "`verify()` privalo pasakyti, ar palyginimas buvo nepriklausomas"
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
      for (const scenarijus of BLOGI_RAKTAI) {
        const operacijos = [
          ["put", () => saugykla.put(scenarijus.raktas, { a: 1 })],
          ["read", () => saugykla.read(scenarijus.raktas)],
          ["head", () => saugykla.head(scenarijus.raktas)],
          ["verify", () => saugykla.verify(scenarijus.raktas, { bytes: 1, checksum: "a".repeat(64) })],
          ["delete", () => saugykla.delete(scenarijus.raktas)],
        ];

        for (const [operacija, veiksmas] of operacijos) {
          await assert.rejects(
            veiksmas,
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
