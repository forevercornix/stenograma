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
