const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { POROS } = require("./helpers/rezultatuPoros");
const { kanoninisRezultatas } = require("../utils/jobStore/common");
const { paruostiReiksme } = require("../utils/artifactStore/validation");
const { createFsArtifactStore } = require("../utils/artifactStore/fsStore");
const { skaitytiRibotai } = require("../utils/artifactStore");
const memoryStore = require("../utils/jobStore/memoryStore");
const { STATUS, OWNER_KIND } = require("../utils/jobStore/common");

/**
 * LYGYBĖS PARITETAS IR ROUND-TRIP IŠTIKIMYBĖ (#157, PR-4).
 *
 * ⚠️ ČIA TIKRINAMA PRIELAIDA, ANT KURIOS STOVI VISAS EXTERNAL IDEMPOTENTIŠKUMAS:
 * kad `checksum` verdiktas sutampa su `kanoninisRezultatas()` verdiktu. Jei kada nors
 * išsiskirs, external kelias pradės skelbti „tas pats rezultatas" ten, kur inline
 * skelbia konfliktą — ir atvirkščiai.
 *
 * ⚠️ TAS PATS SĄRAŠAS TRIMS KELIAMS: kanoninė eilutė, `checksum` ir tikras `fs`
 * round-trip. Pilna `finishAtomic` grandinė su PostgreSQL — `externalCompletion.
 * integration`; čia tikrinama tai, ką galima įrodyti be servisų.
 */

test("checksum verdiktas SUTAMPA su kanoninės eilutės verdiktu", () => {
  /**
   * ⚠️ NESUTAPIMAS YRA DEFEKTAS, NE TOLERUOJAMA RIBA. Checksum yra fast-path, o
   * semantiką sprendžia `kanoninisRezultatas()` — jei jie nesutaria, laimi kanoninė
   * eilutė, ir tai privalo kristi čia, o ne pasirodyti kaip tylus `RESULT_CONFLICT`
   * teisėtam pakartojimui.
   */
  for (const pora of POROS) {
    const kanoninisTapatus =
      kanoninisRezultatas(pora.pirmas) === kanoninisRezultatas(pora.antras);
    const checksumTapatus =
      paruostiReiksme(pora.pirmas).checksum === paruostiReiksme(pora.antras).checksum;

    assert.equal(
      kanoninisTapatus,
      pora.tapatus,
      `${pora.vardas}: kanoninis autoritetas nesutinka su scenarijaus lūkesčiu`
    );
    assert.equal(
      checksumTapatus,
      kanoninisTapatus,
      `${pora.vardas}: checksum ir kanoninė eilutė duoda SKIRTINGĄ verdiktą`
    );
  }
});

test("`bytes` verdiktas nieko nepakeičia — jis yra antra to paties santraukos dalis", () => {
  /**
   * External palyginimas naudoja `checksum` IR `bytes`. Testas fiksuoja, kad `bytes`
   * nesukuria SAVO verdikto: tapačioms poroms jis sutampa, netapačioms — nesvarbu.
   */
  for (const pora of POROS.filter((p) => p.tapatus)) {
    assert.equal(
      paruostiReiksme(pora.pirmas).bytes,
      paruostiReiksme(pora.antras).bytes,
      `${pora.vardas}: tapačios poros privalo turėti tą patį dydį`
    );
  }
});

test("inline kelias (atmintis) duoda TĄ PATĮ verdiktą kaip kanoninė eilutė", async () => {
  /**
   * ⚠️ ATMINTIES BACKEND'AS ČIA YRA INLINE AUTORITETO ATSTOVAS: jis kviečia tą pačią
   * `idempotentiskasAtsakymas()` funkciją kaip PostgreSQL. Pilna PostgreSQL grandinė
   * tikrinama integraciniame rinkinyje.
   */
  for (const pora of POROS) {
    const job = await memoryStore.create({ ownerKind: OWNER_KIND.UNOWNED, type: "protocol" });
    await memoryStore.update(job.id, { status: STATUS.PROCESSING, phase: "generating" });
    await memoryStore.finishAtomic(job.id, STATUS.COMPLETED, { result: pora.pirmas });

    const poPirmo = (await memoryStore.get(job.id, { hydrate: true })).version;

    const verdiktas = await memoryStore.finishAtomic(job.id, STATUS.COMPLETED, {
      result: pora.antras,
    });

    if (pora.tapatus) {
      assert.equal(typeof verdiktas, "object", `${pora.vardas}: laukta no-op`);
      assert.equal(
        verdiktas.version,
        poPirmo,
        `${pora.vardas}: no-op version NEDIDINA — kitaip pakartojimas būtų rašymas`
      );
    } else {
      assert.equal(verdiktas, "RESULT_CONFLICT", `${pora.vardas}: laukta konflikto`);
    }
  }
});

test("`fs` round-trip išlaiko kanoninę tapatybę VISOMS poroms", async (t) => {
  /**
   * ⚠️ DoD: „tas pats loginis rezultatas duoda tą pačią kanoninę eilutę VISUOSE
   * backend'uose po realaus įrašymo ir perskaitymo". Inline pusę tikrina
   * `artifactStoreInline.integration`; čia — `fs`, per tą patį ribotą skaitymo kelią,
   * kurį naudoja hidratacija.
   */
  const saknis = await fsp.mkdtemp(path.join(os.tmpdir(), "stenograma-roundtrip-"));
  t.after(() => fsp.rm(saknis, { recursive: true, force: true }));

  const saugykla = createFsArtifactStore({ root: saknis });
  let seka = 0;

  for (const pora of POROS) {
    for (const reiksme of [pora.pirmas, pora.antras]) {
      seka += 1;
      const raktas = `results/roundtrip/${seka}.json`;
      const kvitas = await saugykla.put(raktas, reiksme);

      const { reiksme: perskaityta, bytes } = await skaitytiRibotai(saugykla, raktas, {
        maxBaitai: 1024 * 1024,
        deklaruotiBaitai: kvitas.bytes,
      });

      assert.equal(
        kanoninisRezultatas(perskaityta),
        kanoninisRezultatas(reiksme),
        `${pora.vardas}: round-trip pakeitė kanoninę tapatybę`
      );
      assert.equal(bytes, kvitas.bytes, `${pora.vardas}: dydis privalo sutapti su kvitu`);
    }
  }
});
