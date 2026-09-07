# #157 PR-4 — mutacijų įrodymai

⚠️ **KODĖL ŠIS FAILAS EGZISTUOJA.**

Mutacijos vykdomos CI (external kelias reikalauja PostgreSQL), laikinoje šakoje, kuri po
paleidimo pašalinama. Lieka `run` numeris — bet ne tai, KAS buvo mutuota. Po kelių
mėnesių tai virstų teiginiu „krito" su nuoroda į raudoną paleidimą, kurio subjekto
nebėra: tiksliai ta pati klasė, kurią PR-4 §9.1 ir taiso.

Todėl kiekvienos mutacijos **patch'as** užrašomas čia. Atkūrimas: pritaikyti diff'ą,
paleisti `npm run test:postgres` (arba CI) ir patikrinti, kad krenta būtent nurodyti
testai.

⚠️ **MUTACIJA PRIVALO ATRODYTI KAIP TIKĖTINAS KODAS.** Pirmoji redakcija naudojo
`if (false && ...)`, ir jos testai NEPASIEKĖ — sustabdė lint (`no-constant-condition`).
Tokia mutacija tikrina linterį, ne sargus.

---

## M1 — pre-check pašalintas (CI `34052512327`)

Pašalinamas ankstyvo grįžimo blokas `paruostiExternalRasyma()` viduje, tad `put()`
kviečiamas visada, net kai objektas vietoje ir metaduomenys sutampa.

```diff
-      if (galva && Number(galva.bytes) === Number(esama.bytes)) {
-        /** `put()` praleidžiamas; verdiktą vis tiek priims transakcija. */
-        return {
-          checksum: paruosta.checksum,
-          bytes: paruosta.bytes,
-          attemptId: null,
-          nuoroda: null,
-          stebetaEilute: null,
-        };
-      }
-
       stebetaEilute = { storageKey: esama.storage_key, storageType: esama.storage_type };
```

**Krenta:** „pakartojimas su TUO PAČIU rezultatu: `put()` NEKVIEČIAMAS, version
nedidėja"; „DU lygiagretūs `finish()` su TUO PAČIU rezultatu: lieka VIENAS objektas".

## M2 — cleanup pašalintas (CI `34052718738`)

```diff
-      if (!isipareigota) await isvalytiBandyma(rasymas);
+      /* MUTACIJA: valymas pašalintas */
```

**Krenta:** „pakartojimas su KITU rezultatu: `RESULT_CONFLICT`, o pralaimėjęs objektas
IŠVALOMAS"; „DU lygiagretūs `finish()` su SKIRTINGAIS rezultatais".

## M3 — registro būsena neatnaujinama (CI `34052933537`)

```diff
-      if (rasymas && rasymas.attemptId) {
-        await attemptRegistry.isipareigoti(client, { jobId: id, attemptId: rasymas.attemptId });
-      }
+      /* MUTACIJA: registro būsena neatnaujinama */
```

**Krenta:** „completion parašo NUORODĄ … uždaro registro eilutę"; **abi** lenktynės.

⚠️ Ši mutacija krenta plačiau, nei vadinasi: „lygiai vienas įsipareigotas įrašas" yra
tikrasis invariantas, kurį ji laužia.

⚠️ **BET JI DENGĖ VIENĄ KELIĄ, NE INVARIANTĄ** (Codex, #294). Tą patį invariantą kita
kryptimi laužia du lygiagretūs REMONTAI to paties dingusio objekto — ir M3 to nepagavo.
Scenarijus pridėtas; jis iškart rado tikrą spragą (senasis bandymas likdavo `committed`
po remonto, CI `34083939521`).

## M4 — būsenų aibė migracijoje (vietinis, abi kryptys)

```diff
-const BUSENOS_FROZEN = ["pending", "committed", "abandoned"];
+const BUSENOS_FROZEN = ["pending", "abandoned"];              // trūkstama būsena
+const BUSENOS_FROZEN = ["pending", "committed", "abandoned", "nezinoma"];  // perteklinė
```

**Krenta:** „būsenų aibė SUTAMPA su migracijos aibe — abiem kryptim" (`attemptRegistry`).

⚠️ Ankstesnė šio testo redakcija ieškojo žodžio šaltinio TEKSTE ir būtų praėjusi: žodis
lieka komentare (§9.2).

## M5 — pralaimėtų lenktynių šaka pašalinta (CI `34124044419`)

```diff
-            if (!remontasTebegalioja) return EXTERNAL_HIDRATUOTI;
-
             await upsertResult(client, id, undefined, rasymas.nuoroda);
```

**Krenta:** „DU lygiagretūs `finish()` su TUO PAČIU rezultatu: lieka VIENAS objektas".
Tvirtinimas — „ir jo objekto nebėra": pralaimėjusysis perjungia nuorodą į savo objektą,
laimėtojo bandymas nuvertinamas, o jo objektas lieka saugykloje (`{ bytes: 41, exists: true }`).

Ši mutacija atsako į klausimą, ar barjerinis testas apskritai JAUTRUS elgesiui. Atsakymas —
taip.

## M5b — ta pati mutacija, BET barjeras neutralizuotas (CI `34124049309`)

```diff
           barjeras.laukiantys += 1;
-          if (barjeras.laukiantys >= 2) barjeras.atrakinti();
-          await barjeras.zadejimas;
+          barjeras.atrakinti();
```

**Prognozė buvo: testas lieka ŽALIAS.** Samprotavimas: be sinchronizacijos antrasis
`finish()` pre-check metu pamatytų jau įsipareigotą eilutę su esančiu objektu, grįžtų
pakartojimo keliu ir mutuotos šakos NEPASIEKTŲ.

**Išmatuota: testas KRENTA — tuo pačiu tvirtinimu ir ta pačia reikšme kaip M5.**

⚠️ **Tai radinys, ne patvirtinimas.** Barjeras NĖRA tai, kas šiam testui suteikia
jautrumą M5 mutacijai: `Promise.all` sukurtas persidengimas šioje aplinkoje įvyksta ir
be jo. Ką barjeras duoda — DETERMINIZMĄ: be jo aptikimas priklauso nuo planuoklio, o
vienas žalias arba raudonas paleidimas apie tai nieko neįrodo (§14.1). Todėl barjeras
paliekamas, bet teiginys apie jį susiaurinamas: jis šalina priklausomybę nuo sėkmės, o
ne sukuria patį lenktynių langą.

## M6 — registro eilutė rašoma PO `put()` (CI `34124053562`)

```diff
-    await attemptRegistry.registruoti(pool, {
-      attemptId,
-      jobId: id,
-      storageType: rasymoSaugykla.backend,
-      storageKey: raktas,
-    });
-
     const kvitas = await rasymoSaugykla.put(raktas, paruosta);
+
+    await attemptRegistry.registruoti(pool, {
+      attemptId,
+      jobId: id,
+      storageType: rasymoSaugykla.backend,
+      storageKey: raktas,
+    });
```

**Krenta:** „registro eilutė egzistuoja JAU TADA, kai prasideda `put()`" —
`expected: 'pending'`, `actual: null`.

⚠️ Būtent tokia mutacija liktų nepastebėta `attemptRegistry` VIENETINIAM testui: jis
`finishAtomic()` niekada nekviečia. Tvarka tikrinama per produkcinį kelią.

## M7 — `UnrecoverableError` vyniojimas pašalintas (CI `34124586230`)

```diff
-          let completedJob;
-          try {
-            completedJob = await jobStore.system.finish(jobId, jobStore.STATUS.COMPLETED, { result });
-          } catch (klaida) {
-            if (!klaida || klaida.neatkartojama !== true) throw klaida;
-
-            const { UnrecoverableError } = require("bullmq");
-            const fatal = new UnrecoverableError(klaida.message);
-            fatal.cause = klaida;
-            throw fatal;
-          }
+          const completedJob = await jobStore.system.finish(jobId, jobStore.STATUS.COMPLETED, { result });
```

**Krenta:** „#157 WORKER: struktūrinis atmetimas → failed po VIENO vykdymo, be
pakartojimų" (redis rinkinys, vykdomas CI).

⚠️ Tai D radinio taisymo įrodymas: be vyniojimo `neatkartojama` ženklas lieka, bet
grandinė nenutrūksta — testas matuoja PAKARTOJIMŲ SKAIČIŲ, ne lauko buvimą.
