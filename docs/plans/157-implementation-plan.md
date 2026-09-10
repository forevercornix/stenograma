# #157 — Artifact storage abstraction: implementacijos planas

**Būsena:** 2 revizija, laukianti patvirtinimo. Kodo nerašyta, šakos nėra, commit'ų nėra.

## Kas pasikeitė šioje revizijoje

Sinchronizuota su atnaujintu #157 body. PR seka (7), `§9.1` analizės, `UNVERIFIED`
lentelė ir „Ko šis planas sąmoningai nedaro" išlaikyti; keista tik tai, ką pakeitė
body arba A1–A4 atsakymai.

| # | Pakeitimas | Kilmė |
|---|---|---|
| 1 | A1–A4 perkelti iš „atvirų klausimų" į **priimtus sprendimus** (§3) | tavo atsakymai |
| 2 | PR-1 apima `bytes`/`checksum` kolonas; external forma **pilna** (5 sąlygos), NOT NULL | A1 + body |
| 3 | PR-1 testų lentelė: du nauji negatyvūs atvejai; `§9.1` — **keturi** sargai, ne du | body |
| 4 | PR-2: `list(prefix)` klausimo nebėra; `head()` leidžiamas **visur**, ribojamas tik turinys | A3 + body |
| 5 | PR-3: hidratacija **bounded**, `MAX_RESULT_BYTES` pagal persistintą `bytes` **prieš** įkėlimą; streaming JSON nereikalaujamas | body |
| 6 | PR-4: I/O tampa **dviejų pakopų** (pre-check → put → head → DB re-check/CAS); no-op grįžta **prieš** `put()`; pridėta mutacija pre-check sargui; pridėtas **lygybės pariteto** įrodymas | body (didžiausias delta) |
| 7 | PR-5: DoD citatos perrašytos pažodžiui iš naujo body; per-row `storage_type` **visiems trims** vartotojams; pridėtas `docs/deletion-guarantees.md`; `list(prefix)` riba + follow-up issue | A3, A4 + body |
| 8 | PR-7: **vidinė commit'ų tvarka** su sargo pašalinimu paskutiniu; tvarka įvardyta kaip review kriterijus; `backupPolicy` per-row | body |
| 9 | §0 lentelė papildyta `head()` kaina `fs` backend'e (nauja HOW pastaba, ne body reikalavimas) | mano sprendimas |
| 10 | **F1:** PR-1 DoD citatos perrašytos pažodžiui iš dabartinio body (5 punktai vietoj 3) | peržiūra |
| 11 | **F2:** `verify()` riba užrašyta trijų lygių lentele; PR-3 skaitiklis skaičiuoja `read` **ir** `verify`; įvardytas reikalingas body pataisymas | peržiūra |
| 12 | **F3:** rakto prefikso pagrindime pašalinta `list(prefix)` nuoroda kaip esama galimybė | peržiūra |
| 13 | **PR-4 cleanup tapo SĄLYGINIS ir serializuotas job eilutės užraktu** — besąlyginis pralaimėjusiojo trynimas su turinio adresu ištrintų laimėtojo objektą | Codex P1 (#289) |
| 14 | **PR-3 riba tapo dviguba:** pigus atmetimas pagal persistintą `bytes` + kietas srauto stabdis; pasenusi maža reikšmė nebeleidžia įkelti didelio objekto | Codex P2 (#289) |
| 15 | **Object key tapo ATTEMPT-UNIQUE**, ne turinio adresas: sąlyginis cleanup su eilutės užraktu NEUŽDARO lenktynių, kai konkurentas jau parašė objektą, bet dar neįėjo į transakciją | Codex P1, antra redakcija (#289) |
| 16 | PR-1 testų lentelė plane sulyginta su faktine forma (`fs` reikalauja pilnos formos; pridėta `s3` eilutė) | Codex (#289) |
| 17 | **Pre-check nebėra lygybės verdiktas:** sutapęs checksum praleidžia tik `put()`, sprendimą priima authoritative re-check | Codex (#289) |
| 18 | Rakto pagrindimas perrašytas kaip **atmestas variantas su priežastimi**; cleanup skyrius suderintas su attempt-unique raktu | Codex (#289) |
| 19 | **Naujas atviras PR-4 sprendimas:** orphan'ai su attempt-unique raktu (trys variantai, rekomendacija — patvarus bandymo registras) | peržiūra |
| 20 | PR-4 cleanup mutacijos perrašytos pagal attempt-unique raktą — senosios nebeatkuria gedimo | Codex (#289) |
| 21 | §3 nebeteigia „atvirų klausimų nebėra": orphan strategija lieka atvira ir blokuoja PR-4 pradžią | Codex (#289) |
| 22 | **No-op reikalauja ir `head()` patikros:** sutapęs checksum nebeleidžia skelbti sėkmės virš pakibusios nuorodos | Codex (#289) |
| 23 | **Stebėtojo mutacija taisyta:** skaldyti reikia TRANSAKCIJĄ, ne sakinį — vienos transakcijos vidinė būsena išoriniam stebėtojui nematoma | Codex (#289) |
| 24 | **PR-3 metaduomenų `SELECT` traukia rezultato reference laukus** — be jų PR-5 per-row sprendimas buvo neįvykdomas nurodymas | Codex (#289) |
| 25 | **PR-2 riba atmeta reikšmes, kurių tapatybė pasikeistų inline kelyje** (`Date` ir kt. su prototipo `toJSON`) — išmatuota divergencija, kurios `fs` rinkinys nepagautų | peržiūra |
| 26 | **Struktūrinis atmetimas žymimas `neatkartojama`; PR-4 privalo jį vynioti į `UnrecoverableError`** | peržiūra (#153 precedentas) |
| 27 | Užrašyta, kad stabilumo predikatas yra inline kelio **modelis**, ne pats kelias — inline pariteto testo jis nepakeičia | peržiūra |
| 28 | **`put()` grąžina `key` (adresas) IR `reference` (kas persistinama, `null` inline)** — kitaip inline išgalvotų sentinelį ir gautų `23514` | peržiūra |
| 29 | **`verify()` grąžina `nepriklausomas`** — inline patikra lygina reikšmę su savimi; užrašyta kaip 7.6 restore riba | peržiūra |
| 30 | PR-4 gauna ELGESIO DoD punktą: struktūrinis atmetimas duoda nulį BullMQ pakartojimų | peržiūra |
| 31 | **Atsakyta, kada `delete()` kviečiamas:** `reference !== null` → saugykloje; `null` → eilutės ištrynimas IR YRA ištrynimas | peržiūra |
| 32 | **PR-7 DoD per ataskaitos turinį:** patikrintų ir nepatikrinamų eilučių skaičiai pateikiami atskirai | peržiūra |
| 33 | **Kontraktas gavo EXTERNAL pakopą** — attempt-uniqueness garantija turi namus; be jos ji gyventų tik plane | peržiūra |
| 34 | **PR-4 skirsto pagal `reference === null`, ne pagal backend'o vardą** | peržiūra |
| 35 | **PR-7 ataskaita skirsto pagal `nepriklausomas`, ne `ok`** — inline `ok: true` yra tikras, bet tuščias | peržiūra |
| 36 | **`fs` `.tmp` likučiai įvardyti kaip TREČIAS to paties orphan reiškinio veidas** — sprendžiami kartu PR-4, ne taškiškai PR-2 | Codex (#290) |
| 37 | **PR-2 parinkimo testas kviečia `require("../utils/artifactStore")`, ne `backendSelection` tiesiogiai** — vartotojai (PR-3+) eis įėjimu, tad rinkinys privalo eiti tuo pačiu; mutacija (įėjimas nustoja eksportuoti parinkimą) — 5/6 krito | įgyvendinimas |
| 38 | **Riba paskaičiuoja kvitą, o implementacija nebeserializuoja iš naujo** — inline `put()` rašė `JSON.stringify(reiksme)` antrą kartą; tarp kvito ir įrašymo reikšmė gali pasikeisti, ir `checksum` aprašytų NE TAI, kas įrašyta | Codex (#290) |
| 39 | **`fs` riba taikoma per VARTUS, ne per operaciją** — `realpath` darė tik `head`/`put`; `delete` symlink'ą praleisdavo. Vienas resolveris; `leksinisKelias()` už jo nekviečiamas niekur | Codex (#290) |
| 40 | **Raktų matrica išvedama iš saugyklos paviršiaus** — ranka surašyta buvo praleidusi `readStream`; nauja operacija be eilutės sustabdo rinkinį | Codex (#290) |
| 41 | **Taisyklė vietoj sąrašo:** „tikras escape, ne tekstas apie escape" gyvena vienoje vietoje; NUL `includes` patikra atmesdavo teisėtą tekstą, kurį PG priima | Codex (#290) |
| 42 | **`NaN`/`±Infinity` viršutiniame lygyje atmetami** — kanonizavimas juos paverčia `null`, t. y. „rezultato nebuvimu"; viduje esantys lieka nuostolingi, bet vieningi | Codex (#290) |
| 43 | **`jsonb` kandidatų aprėptis įvardyta kaip REPREZENTATYVI** (§12.1), ir kiekviena ribos taisyklė gauna teisėtą kaimyną — antra kryptis anksčiau nebuvo matuojama | Codex (#290) |
| 44 | **`verify()` normalizuoja laukiamus metaduomenis** — `bigint` per `node-postgres` grįžta eilute, tad `===` skelbtų kiekvieną DB paremtą artefaktą sugadintu (P1) | Codex (#290) |
| 45 | **`verify()` yra pilna funkcija** — nesančio objekto verdiktas neša visus laukus, `nepriklausomas` įskaitytinai; forma viena, ne trys | Codex (#290) |
| 46 | **Viešas klaidos tekstas gaminamas iš KODO** — `JSON.parse` diagnostika neša artefakto turinio fragmentą į savininkui matomą lauką | Codex (#290) |
| 47 | **`ARTIFACT_CORRUPT` atskiriamas nuo `ARTIFACT_NOT_FOUND`** — sugadintas objektas guli vietoje, tad remontas kitas | Codex (#290) |
| 48 | **Plano teiginys apie `reference === null` buvo per stiprus** — inline bandymai dalijasi `job_id`, tad `ON CONFLICT DO UPDATE` perrašo nugalėtojo rezultatą prieš completion CAS. Predikatas galioja cleanup/orphan klausimui, NE „pralaimėjusio bandymo nėra" | Codex (#290) |
| 49 | **PR-3: `listByFlag()` irgi grąžina nehidratuotą projekciją** — `payload` ji netempė, bet `rowToJob()` pridėdavo `result: null`, t. y. teigdavo „rezultato nėra" apie job'ą, kurio rezultatas yra | įgyvendinimas |
| 50 | **PR-3: rezultato NUORODA (`storage_type`, `storage_key`, `bytes`, `checksum`) lieka VIDINĖ** — traukiama metaduomenų užklausoje PR-5 sprendimui, bet į bendrą job modelį nepatenka | įgyvendinimas |

Nepakito: PR skaičius ir tvarka, §1 grafas, §2 `UNVERIFIED` lentelė, §4.

---

**Autoritetai perskaityti:** `AGENTS.md` (visas), #157 body (dabartinė versija),
`docs/decisions/155-postgres-authority.md` §AKTYVAVIMO BARJERAS,
`docs/artefact-lifecycle.md`, `docs/deletion-guarantees.md`,
`docs/backup-runbook.md` §9a/§9b/§9c/§11.

---

## 0. Ką patikrinau kode prieš planuodamas

Visos #157 įvardytos AS-IS vietos patvirtintos. Dvi turi **eilučių poslinkį** po
PR #288 (7.6c uždarymas) — planas naudoja dabartinius numerius ir įvardija abu:

| #157 nurodo | Faktinė vieta dabar | Patvirtinta |
|---|---|---|
| `migrations/1755000000000_...:309-311` | ta pati | `storage_type IN ('inline','s3')` — `fs` neteisėtas |
| `migrations/1755000000000_...:317-323` | ta pati | `ELSE storage_key IS NOT NULL` — `payload` external atveju NEUŽDRAUSTAS |
| `postgresStore.js:739-745` | ta pati | `ON CONFLICT ... SET payload = EXCLUDED.payload`; `storage_type`/`storage_key` neliečiami |

⚠️ **ŠI EILUTĖ PASENUSI IR NUMERIU, IR TEIGINIU (§12.1).** `ON CONFLICT ... SET payload = EXCLUDED.payload` nebėra ties `:739-745` (dabar ~`:966`), ir svarbiau — besąlyginio `payload` perrašymo TEN NEBĖRA: 7.5b jį pakeitė, ką sako pats kodo komentaras („Iki 7.5b čia buvo... BESĄLYGINIS"). Numerio taisymas vienas išsaugotų neteisingą teiginį, tad eilutė paliekama pažymėta ir peržiūrima kartu su PR-7 backup/restore darbu, ne tyliai pataisoma.
| `postgresStore.js:579-583` | ta pati | `SELECT_JOB` = `LEFT JOIN job_results` + `r.payload AS result` |
| `postgresStore.js:2362-2377` | ta pati | `listByFlag()` sąmoningai be prijungimo — precedentas |
| `postgresStore.js:1034-1041` | ta pati | `rezultatoEilute()` po `FOR UPDATE OF j` |
| `postgresStore.js:1623-1627` | ta pati | non-inline fail-closed sargas |
| `services/backupService.js:259-262` | ta pati | `countActiveJobs()` per `listAll()`, naudoja tik `status` |
| `services/lifecycleService.js:118, 393-394` | **`:129`, `:434`** | PR #288 įterpė `COVERED_CATEGORIES` predikatus. ⚠️ **`STORED_IN_JOB_RECORD` logika PAKITO (PR-5):** `:434` dabar yra `if (outcome.jobRemoved || externalNebera)` — `externalNebera` dengia external eilutę, kurios objekto nebėra, įskaitant NAŠLAIČIŲ kelią, kur `jobRemoved` visada `false`. Teiginys „nepakitusi" buvo teisingas iki PR-5 ir nuo tada klaidina |
| `utils/artefactScanner.js:117-123` | **PAKEISTA (PR-5)** | `scan: null` liko, bet PRIEŽASTIS perrašyta: „inline eilutėse saugoma job_record viduje; **external eilutės tikrinamos per registrą**". Senoji formuluotė po #157 buvo netiesa — ji teigė, kad turinys visada eilutėje |
| `utils/artefactInventory.js` | `:77`, `:98` | „…jobo įraše" / „…jobo rezultate" |
| `utils/backupPolicy.js:94,96` | ta pati | `transcript`/`protocol` → `"job_results"` |
| `utils/resultLimits.js:154` | ta pati | `MAX_RESULT_BYTES` = 20 MiB |

Papildomai patvirtinta, kas planą formuoja:

- `rowToJob` (`postgresStore.js:69`) rezultatą prikabina kaip `result: row.result`
  — hidratacijos riba yra **viena vieta**, ne išbarstyta;
- kontraktinių rinkinių precedentas jau yra: `jobStoreBackendContract`,
  `sessionStoreBackendContract`, `auditStoreBackendContract` — `artifactStoreContract`
  seks ta pačia forma;
- `utils/fileStorage.js` eksportuoja `{ put, putAtKey, putFile, get, del, STORAGE_DIR, _resolve }`
  — tai audio saugykla, **ne** `ArtifactStore`; `FsArtifactStore` jos nepakeičia
  ir jos semantikos neperima;
- fail-fast stilius, kurį #157 nurodo sekti, yra `backendSelection.js:75-95`
  (eksplicitinis backend be priklausomybės → `throw`, ne fallback).

---

## 1. PR seka

Septyni PR. Kiekvienas palieka repo veikiantį ir `npm test` žalią; barjeras
uždarytas visuose.

```
PR-1 schema ──► PR-2 boundary ──► PR-3 hydration ──► PR-4 completion/concurrency ──┐
                                                                                    │
                              PR-5 erasure + registras ◄──────────────────────────┘
                                        │
                                        ├──► PR-6 migracija
                                        └──► PR-7 backup/restore + sargo pašalinimas
```

PR-7 yra vienintelis, kuris liečia `postgresStore.js:1623-1627`.

---

### PR-1 — Schema: `fs` reikšmė ir sustiprintas `storage_shape`

**Ką palieka veikiantį:** nieko nekeičia elgesiui — produkcinis kelias rašo
`inline`, o sustiprintas invariantas inline eilutėms galioja taip pat kaip anksčiau.

**Failai**
- `backend/migrations/<ts>_job-results-external-storage.js` (nauja)
- `backend/tests/migrations.integration.test.js` (papildoma)

**Migracijos turinys** — senos migracijos neliečiamos:
1. dvi naujos kolonos: `bytes bigint`, `checksum text` (A1);
2. `job_results_storage_type_values` → `storage_type IN ('inline','fs','s3')`;
3. `job_results_storage_shape` → external šaka **pilna**:
   `storage_key IS NOT NULL AND payload IS NULL AND bytes IS NOT NULL AND checksum IS NOT NULL`.

⚠️ **`NOT NULL` išreiškiamas per `CHECK`, ne per kolonos apibrėžimą.** Kolonos
privalo likti nullable `inline` eilutėms (jos `bytes`/`checksum` neturi ir neturės),
tad privalomumas galioja TIK external šakai — būtent taip, kaip `payload` ir
`storage_key` jau elgiasi šiame pačiame invariantje.

⚠️ **Migracija privalo tikrinti esamas eilutes.** Jei produkcijoje jau būtų
`s3 + payload` hibridas (schema tai leidžia), `ALTER ... ADD CONSTRAINT` kristų
vidury. Sprendimas: migracija pirma `SELECT count(*)` tokių eilučių ir, radusi,
krenta su aiškia žinute — **ne** tyliai jas „pataiso". Duomenų taisymas be
operatoriaus sprendimo čia būtų tas pats dalinis ištrynimas kita forma.

**DoD, kuriuos uždaro** (pažodžiui iš dabartinio body):
- „Esami `storage_type` / `storage_key` / `payload` DB invariantai inventorizuoti ir reuse'inami; jau pritaikyta migracija neredaguojama vien tam, kad būtų palengvintas #157."
- „Nauja migracija prideda `fs` prie `job_results_storage_type_values`; `FsArtifactStore` reference įrašomas be schemos apėjimo."
- „Nauja migracija sustiprina `job_results_storage_shape` iki pilnos external formos: `storage_type ∈ {fs, s3} AND storage_key IS NOT NULL AND payload IS NULL AND bytes IS NOT NULL AND checksum IS NOT NULL`. Integrity metaduomenys tampa DB invariantu, ne aplikacijos susitarimu."
- „Negative testai: DB atmeta `external + payload`, `external + bytes IS NULL` ir `external + checksum IS NULL`. Kontrolė: `inline + payload` praeina, `inline + storage_key` atmetamas."
- „Nauja migracija prideda vientisumo kolonas (`bytes`, `checksum`) į `job_results`, ir **external šakoje jos privalomos (`NOT NULL`)**. Nullable paliktos, jos atkartotų tą pačią spragą kaip `payload`: DB leistų external eilutę, su kuria restore verifikacija neturėtų ko palyginti."

**Testai** (integraciniai, `postgres` rinkinys)
| Testas | Tvirtina |
|---|---|
| `s3 + storage_key + payload` → `23514` | sustiprintas invariantas veikia |
| `fs + storage_key + bytes + checksum` → praeina | `fs` teisėtas TIK pilna forma |
| `fs + payload` → atmetamas | `fs` nėra „inline su kitu vardu" |
| `s3 + storage_key + bytes + checksum` → praeina | atgalinis suderinamumas: aibė PRAPLEČIAMA, ne keičiama |
| `fs + storage_key + checksum` be `bytes` → atmetamas | integrity metaduomenys yra DB invariantas |
| `fs + storage_key + bytes` be `checksum` → atmetamas | tas pats antrai reikšmei |
| `inline + payload` → praeina | **kontrolė**: nesugriauta esama forma |
| `inline + storage_key` → atmetamas | **kontrolė**: sena šaka gyva |
| `inline` be `bytes`/`checksum` → praeina | **kontrolė**: naujos kolonos inline eilutės neapkrauna |

**§9.1 — sargų yra keturi, ne du.** Kiekvienas turi testą, kuris jį jaučia:

| Sargas | Mutacija | Krenta? |
|---|---|---|
| `fs` reikšmės praplėtimas | grąžinam `IN ('inline','s3')` | taip — pilnos formos `fs` eilutė gauna `23514` |
| `s3` išlaikymas aibėje | mutuojam į `IN ('inline','fs')` | taip — galiojantis `s3` reference nebeįrašomas |
| `payload IS NULL` external | grąžinam `ELSE storage_key IS NOT NULL` | taip — `s3 + payload` įsirašo |
| `bytes IS NOT NULL` external | išimam iš `CHECK` | taip — eilutė be `bytes` įsirašo |
| `checksum IS NOT NULL` external | išimam iš `CHECK` | taip — eilutė be `checksum` įsirašo |

⚠️ Trečias ir ketvirtas sargai atrodo simetriški, bet **mutuojami atskirai**:
bendras „integrity metaduomenys privalomi" testas praeitų padengęs vieną iš dviejų
(ta pati klaida, kurią 7.6c padarė su trimis trumpaisiais keliais).

---

### PR-2 — `ArtifactStore` boundary + kontraktų rinkinys

**Ką palieka veikiantį:** boundary egzistuoja ir yra padengtas, bet produkcinis
kelias jo dar nekviečia. `inline` elgesys nepakitęs.

**Failai**
- `backend/utils/artifactStore/index.js` — fasadas + backend'o parinkimas
- `backend/utils/artifactStore/inlineStore.js`
- `backend/utils/artifactStore/fsStore.js`
- `backend/utils/artifactStore/s3Store.js`
- `backend/utils/artifactStore/backendSelection.js` — fail-fast konfigūracija
- `backend/tests/helpers/artifactStoreScenarios.js` — VIENAS scenarijų sąrašas
- `backend/tests/artifactStoreContract.test.js` — inline + fs (vietoje)
- `backend/tests/artifactStoreBackendContract.integration.test.js` — s3/MinIO
- `backend/tests/artifactStoreConfig.test.js` — startup validacija

**Paviršius** (minimalus, ne „S3 klientas"):
```
put(key, value)      → { key, reference, bytes, checksum }   // `reference` = tai, kas keliauja į `storage_key`; inline atveju `null`
read(key)            → loginė reikšmė (ne eilutė)
readStream(key)      → Readable
head(key)            → { exists, bytes, checksum? } | null
verify(key, laukiama)→ { ok, bytes, checksum }   // tik vientisumo keliams
delete(key)          → boolean   // false = jau nebuvo (7.6c pamoka)
```

⚠️ `delete()` grąžina `boolean`, ir tai **ne stilius**: PR #288 parodė, kad
dublis, grąžinantis `undefined` vietoj `boolean`, tampa antrąja specifikacija ir
paslepia defektą (#266 trečia dalis). Kontraktinis rinkinys tikrina abu atvejus.

**Mano sprendimai iš §3**

*Object key schema:* `results/<jobId>/<attemptId>.json`, kur `attemptId` yra
šio rašymo bandymo UUID. Tapatybę neša `checksum` KOLONA; raktas jos nedubliuoja
nė viena kryptimi.

⚠️ **ATMESTAS VARIANTAS: TURINIO ADRESAS `<sha256(kanoninisRezultatas)>.json`.**

Jis atrodė pakankamas, ir argumentas buvo tikras: hash duoda immutability **be
papildomos būsenos** — du worker'iai su tuo pačiu loginiu rezultatu taikosi į tą
patį raktą (idempotencija natūrali), su skirtingu — į skirtingus. Attempt-UUID
tada atrodė kaip nereikalingas registras.

Jis nepakanka dėl vienos konkrečios priežasties: **du bandymai dalijasi tuo pačiu
objektu**. Kritęs A gali ištrinti objektą, kurį B ruošiasi referencuoti, ir
eilutės užraktas to neapsaugo, nes B `put()` įvyko PRIEŠ transakciją (Codex P1,
#289). Attempt-unique raktas šitą pašalina konstrukciškai: vienas bandymas —
vienas objektas, ir svetimo liesti fiziškai nėra kaip.

Užrašyta kaip atmestas variantas su priežastimi, o ne ištrinta: be jos „hash
duoda immutability be papildomos būsenos" yra pakankamai geras argumentas, kad
po kelių mėnesių būtų pasiūlytas iš naujo.

`jobId` prefiksas reikalingas **erasure** keliui (žinoti, kuriuos raktus liesti
šalinant job'ą), o ne tapatybei; `attemptId` — kad du rašytojai negalėtų dalintis
objektu. ⚠️ Prefiksas NĖRA orphan skenavimo priemonė: `list(prefix)` į kontraktą
neįeina (A3), tad jis šiandien yra tvarkos, o ne aptikimo savybė.
⚠️ Riba užrašoma: hash naudojamas TIK `checksum` kolonoje, **ne** kaip lygybės
taisyklė ir **ne** kaip rakto komponentas — lygybę toliau sprendžia
`kanoninisRezultatas()` (`common.js:731`).

*Integrity reikšmė:* `bytes` + `sha256(kanoninisRezultatas(result))` persistinami
**DB pusėje kartu su reference** write metu (PR-1 kolonos). Checksum skaičiuojamas
iš kanoninės eilutės PRIEŠ rašymą ir niekada — iš saugykloje gulinčių baitų ar iš
object key.

*`head` vs `read`:* `head()` leidžiamas **visuose** keliuose, įskaitant
metadata-only; ribojamas tik turinio skaitymas (`read`/`readStream`). Riba
įgyvendinama ne komentaru, o tuo, kad metadata keliai `ArtifactStore.read`
**neturi kur** iškviesti (žr. PR-3).

⚠️ **`head()` kaina skiriasi tarp backend'ų, ir tai HOW sprendimas.** S3 dydį ir
ETag grąžina metaduomenimis; `fs` checksum'o iš anksto neturi ir jį gautų tik
perskaitęs failą. Todėl `head()` grąžina `{ exists, bytes }` visada, o `checksum`
— tik kai backend'as gali jį duoti nebrangiai. Vientisumo palyginimą, kuriam
checksum'o reikia visada, atlieka `verify(key, laukiama)` — ne metadata keliai.

⚠️ **`verify()` YRA TURINIO KELIAS KITU VARDU, IR RIBA GALIOJA JAM TAIP PAT.**
`fs` backend'e jis perskaito visą objektą. Jei jis atsirastų sweeper'yje ar
reconcile kelyje, PR-3 mutacijos testas liktų žalias (jis skaičiuoja `read`), o
metadata praėjimas temptų 20 MiB objektus — tiksliai ta pati „antra specifikacija"
klasė, kurią šis planas cituoja dėl `delete()` grąžinamo tipo.

Todėl riba yra **trijų lygių**, ne dviejų:

| Operacija | Kur leidžiama | Kaina |
|---|---|---|
| `head()` | **visur**, įskaitant metadata-only | pigi (S3: metaduomenys; `fs`: `stat`) |
| `verify()` | **tik** vientisumo keliuose — PR-7 restore, orphan patikra | `fs` skaito visą objektą |
| `read()` / `readStream()` | tik turinio keliuose | pilnas skaitymas |

⚠️ **IŠ TO SEKA BODY PATAISYMAS.** Dabartinis DoD sakinys „Egzistavimo /
vientisumo (`head`) užklausa nedraudžiama" po šio skaidymo leidžia per daug:
vientisumas persikėlė į `verify()`, kuris metadata keliuose draudžiamas. Formuluotė
turi skirti abu — plane ji naudojama siaurąja prasme, bet **autoritetas yra body**,
ir ten ji taisytina.

⚠️ **`list(prefix)` į kontraktą NEĮEINA** (A3). Orphan aptikimas apibrėžiamas DB
kryptimi; priešinga kryptis — atskiro darbo apimtis, ir riba užrašoma PR-5.

⚠️ **PR-4 DoD PUNKTAS (elgesio, ne lauko): „struktūrinis atmetimas completion
metu duoda NULĮ BullMQ pakartojimų".**

Nuoroda plane nieko nesulaužo; krentantis testas sulaužo. Todėl PR-4 privalo
turėti testą, matuojantį PAKARTOJIMŲ SKAIČIŲ, ne `neatkartojama` lauko buvimą:
job'as su `Date` rezultate baigiasi `failed` po VIENO vykdymo, `attempts` nedidėja.

⚠️ **PR-4 PRIVALO SUVYNIOTI STRUKTŪRINĮ ATMETIMĄ Į `UnrecoverableError`.**

`ArtifactStore` klaidos žymimos `neatkartojama: true`, o `jobRunner._classifyError()`
jas atpažįsta ir grąžina savo kodą. Bet **ženklas vienas nieko nesustabdo**:
BullMQ retry grandinę nutraukia tik `UnrecoverableError`, kurį uždeda KVIETĖJAS —
lygiai kaip `assertResultWithinLimits` (`workers/index.js:359-366`). Be to vienas
netinkamas laukas kainuotų `attempts` × pilną transkribavimą arba LLM kvietimą ir
vis tiek baigtųsi klaida.

Tai PR-4 darbas, nes completion kelias `put()` kviečia būtent ten; PR-2 palieka
paruoštą ženklą ir klasifikaciją, ne garantiją.

⚠️ **ŠIS DoD PUNKTAS PR-4 METU LIEKA NEĮRODYTAS — IR NE VIEN DĖL AKTYVAVIMO.**

Pirma priežastis buvo žinoma: `rasymoSaugykla` produkcijoje neįjungta (PR-7), o
PostgreSQL kelią uždaro `POSTGRES_AKTYVAVIMAS_LEISTAS`, tad grandinė
„struktūrinis atmetimas → nulis pakartojimų" nepaleidžiama nuo galo iki galo.

Antra priežastis paaiškėjo šiame raunde ir yra svarbesnė: **validacija pririšta
prie ne to sluoksnio**. Struktūrinį atmetimą gamina `ArtifactStore` riba, tad
kelias, einantis pro ją (Redis, atmintis — būtent tie, kurie aktyvūs ŠIANDIEN),
`Date` rezultatą priima ir jokio atmetimo negamina. Vadinasi, punktas neįrodomas
ne todėl, kad grandinė neįjungta, o todėl, kad įjungus vieną jos galą kitas
galas vis tiek liktų neuždengtas. Invariantas kyla iš `common.js` lygybės
autoriteto, ne iš `ArtifactStore` — išmatuota ir aprašyta **#298**.

Iki #298 uždarymo šis DoD punktas žymimas `PARTIAL / UNVERIFIED`, ne `DONE`.

**DoD, kuriuos uždaro**
- „Vienas `ArtifactStore` production boundary; business/service sluoksnis neatlieka tiesioginio filesystem/S3 I/O."
- „Inline, filesystem ir S3-compatible implementacijos praeina tą patį `artifactStoreContract`."
- „Eksplicitiškai pasirinkto `fs` / `s3` backend'o konfigūracija validuojama startup metu fail-fast…"

**§9.1:** startup validacijos testas paleidžia **tikrą** `selectBackend({ARTIFACT_STORE_BACKEND:"fs"})` be root konfigūracijos ir laukia `throw`; pašalinus patikrą — grąžintų `inline` ir testas **krenta**. Kontrolė: be `ARTIFACT_STORE_BACKEND` startas `inline` režimu **privalo praeiti** (inline nėra fallback, bet yra teisėtas numatytasis).

⚠️ **UNVERIFIED:** `S3ArtifactStore` elgesys. Vietoje neįrodomas.
`REQUIRE_MINIO=1 MINIO_ENDPOINT=... npm run test:s3` —
komanda įvardyta PR aprašyme, rezultatas — CI.

---

### PR-3 — Hydration riba

**Ką palieka veikiantį:** `get()`/`readJob()` elgesys nepakitęs `inline` atveju;
metadata keliai nustoja tempti `payload`.

**Failai**
- `backend/utils/jobStore/postgresStore.js` — `SELECT_JOB` skaidymas į
  `SELECT_JOB_META` ir `SELECT_JOB_WITH_RESULT`; `rowToJob` gauna `hydrate` požymį.
  ⚠️ `SELECT_JOB_META` traukia rezultato **reference** laukus (`storage_type`,
  `storage_key`, `bytes`, `checksum`) BE `payload` — be jų PR-5 per-row sprendimas
  neįvykdomas (Codex #289)
- `backend/services/backupService.js` — `countActiveJobs()` per metadata kelią
- `backend/tests/jobStoreHydration.integration.test.js` (nauja)

**Sprendimas:** hidratacija tampa **eksplicitiniu argumentu** (`get(id, {hydrate})`),
o ne numanoma. Numatytoji reikšmė — hidratuoti, kad viešas kontraktas nepasikeistų;
metadata keliai perduoda `hydrate: false`. `listByFlag()` jau elgiasi taip —
`SELECT_JOB` skaidymas tik išplečia esamą precedentą, o ne įveda naują taisyklę.

**Riba tikrinama PRIEŠ įkėlimą, ne po jo.** Hidratuojant external rezultatą
`MAX_RESULT_BYTES` lyginamas su **persistintu `bytes`** (PR-1 kolona), ir viršijus
ribą turinys apskritai neskaitomas.

⚠️ **VIEN PERSISTINTO `bytes` NEPAKANKA** (Codex P2, #289). Jei objektas
saugykloje perrašytas ar sugadintas iki didesnio, pasenusi maža reikšmė patikrą
praeitų, ir į atmintį vis tiek patektų savavališkai didelis turinys. Todėl riba
yra **dviguba**:

1. **pigus atmetimas** — `persistintas bytes > MAX_RESULT_BYTES` → net nekreipiamės
   į saugyklą;
2. **kietas stabdis** — skaitymas eina per srautą su baitų skaitikliu, ir jis
   nutraukiamas, kai viršijamas mažesnysis iš (`persistintas bytes`,
   `MAX_RESULT_BYTES`). Neatitikimas tarp deklaruoto ir faktinio dydžio yra
   gedimas, ne tyliai priimama būsena.

Antrasis punktas yra tas, kuris garantuoja ribotumą: pirmasis tik taupo I/O. Tai skiriasi nuo inline kelio, kur riba
tikrinama prieš rašymą — bet klausimas tas pats: į atmintį nepatenka tai, kas
netelpa.

⚠️ **Streaming JSON rekonstrukcijos nėra ir nereikia.** Loginis `job.result`
galiausiai vis tiek tampa objektu atmintyje, tad hidratacija yra **bounded**
operacija. Streaming taikomas RAW turinio keliui (download, backup, artefakto
kopijavimas), kuris eina per `readStream()` ir kurio šis PR neliečia.

**DoD**
- „Metadata-only read keliai (authorization, listing, sweep/reconcile, `countActiveJobs`) nehidratuoja external result payload; testas fiksuoja, kad tokiuose keliuose nevykdomas objekto **turinio** skaitymas. Egzistavimo / vientisumo (`head`) užklausa nedraudžiama."
- „Loginė `job.result` hidratacija yra bounded: `MAX_RESULT_BYTES` tikrinamas prieš turinio įkėlimą pagal persistintą `bytes`. Streaming JSON rekonstrukcija nereikalaujama."
- „Viešas job/result kontraktas nepriklauso nuo storage backend…" (dalinai; užbaigia PR-4)

**§9.1 — čia lengviausia parašyti bevertį testą.** „Spy ant `ArtifactStore.read`"
nustatytų tik tai, kad *šiandien* niekas nekviečia. Todėl testas naudoja
**skaitiklį pačiame store'e** ir tikrina: `countActiveJobs()` → `perskaityta === 0`,
o `get(id)` → `perskaityta === 1`.

⚠️ **SKAITIKLIS SKAIČIUOJA `read` IR `verify`, NE VIEN `read`.** `fs` backend'e
`verify()` perskaito visą objektą, tad skaitiklis, matantis tik `read`, leistų
metadata keliui tempti artefaktus per kitą metodą ir liktų žalias. Tai ta pati
klaida, kurią 7.6c padarė su audito seamu: patikra, per siaura savo pavadinimui.
`head()` skaičiuojamas atskirai ir **nėra** pažeidimas — jo metadata keliuose
laukiama.
Antroji pusė yra kontrolė: be jos patikra virstų visada-„taip", nes external
kelio dar nėra. Pašalinus `hydrate:false` iš `countActiveJobs` → **krenta**.

Antras sargas — dydžio riba: eilutė su `bytes > MAX_RESULT_BYTES` privalo kristi
**nepakvietusi** `read()` (skaitiklis 0). Pašalinus patikrą, `read()` būtų
kviestas → **krenta**. Kontrolė: eilutė po riba hidratuojama normaliai.

⚠️ **UNVERIFIED:** reali `SELECT_JOB` nauda dydžiu (GiB netempimas) — matuojama
tik su tikra DB ir tikru duomenų kiekiu. Testas įrodo **kelią**, ne apimtį.

---

### PR-4 — Completion, concurrency ir round-trip tapatybė

**⚠️ ATVIRAS KLAUSIMAS, PERIMTAS IŠ PR-3: hidratacijos aibė tebėra SURAŠOMA, ne
išvedama.**

PR-3 metu keturios paieškos davė keturis nepilnus sąrašus: store metodai → maršrutai
→ `jobStore.get()` vardas → `restoredJobStore` adapteris. Visos keturios rėmėsi
SINTAKSINIU raktu, o adapteris `store` perpakuoja nauju vardu — vardas dingsta,
paieška pagal vardą dingsta kartu. Penktas grep duotų penktą nepilną sąrašą.

Teisingas sprendimas — **apversti numatytąją reikšmę**: `system.get()` reikalauja
eksplicitinio `hydrate`, tad kiekvienas kvietėjas (dabartinis, būsimas, per adapterį
ar tiesiogiai) privalo pasirinkti, o praleistus parodo testai, ne atmintis. Viešas
`jobStore.get()` numatytosios reikšmės nekeičia.

⚠️ **PR-3 TO NEPADARĖ, IR PRIEŽASTIS UŽRAŠOMA:** `.system.get(` turi 7 kvietimus
gamyboje ir **127 testuose** (34 failai). Mechaninis 127 vietų pakeitimas į
`{ hydrate: true }` uždarančiame PR būtų diff'as, kuris nieko neteigia, ir paskandintų
tikrąjį pakeitimą. Vietoj to PR-3 uždarė MECHANIZMĄ, kuris ketvirtąjį atvejį paslėpė:
`restoredJobStore` metodai generuojami, tad adapteris nebegali susiaurinti parašo.

✅ **PADARYTA PR-4 METU.** `system.get()` be `hydrate` dabar meta `TypeError`; viešas
`jobStore.get()` nepakitęs (ten sprendžia operacija).

⚠️ **IŠMATUOTAS REZULTATAS: 0 naujų gamybos kvietėjų.** Apvertimas nesugriovė nė vieno
produkcinio kelio, kurio nebūtų PR-3 lentelėje — visi septyni jau ten buvo. Vadinasi
keturios paieškos galiausiai BUVO pilnos gamybos kodui; bet tai žinoma tik dabar, po
struktūrinės patikros, o ne tada, kai sąrašas buvo skelbiamas baigtu. Skirtumas tarp
„buvo teisinga" ir „buvo įrodyta" — ir būtent jį apvertimas ir uždaro.

Kaina: 127 kvietimai 34 testų failuose gavo eksplicitinę vėliavą (mechaninis pakeitimas,
išsaugantis ankstesnį elgesį — numatytoji reikšmė buvo `true`).

**⚠️ ĮĖJIMO SĄLYGOS — ABI PRIIMTOS, VIENOJE VIETOJE.**

PR-4 forma priklauso nuo dviejų sprendimų, priimtų peržiūrose ir išbarstytų po
skirtingus skyrius. Surašomi čia, kad PR-4 pradžioje nereikėtų jų ieškoti:

1. **Orphan strategija: (b) — patvarus bandymų registras** (skyrius „PRIIMTAS PR-4
   SPRENDIMAS" žemiau). Registro įrašas atsiranda PRIEŠ `put()`, dengia visus tris
   orphan veidus, erasure trina PAGAL REGISTRĄ, retencija išvedama iš
   `revivalHorizonsMs()`.
2. **Inline rašymas privalo vykti completion transakcijoje / CAS** (žr. §3 pabaigą).
   Du bandymai dalijasi `job_id`, o `ON CONFLICT (job_id) DO UPDATE SET payload`
   perrašo nugalėtojo rezultatą DAR PRIEŠ completion CAS. Tai lenktynių, ne orphan
   klausimas — išorinio objekto čia nėra.

Abi sąlygos keičia rašymo kelio FORMĄ, tad įterptos vėliau reikštų perrašymą.

⚠️ **ATVIRA RIZIKA, LIEČIANTI AKTYVŲ KELIĄ: #298.** Kanoninė rezultato tapatybė
neišlieka po persistavimo, tad teisėtas pakartojimas Redis kelyje gauna
`RESULT_CONFLICT` (išmatuota prieš tikrą Redis). Tai ne #157 grandinės ateities
klausimas: Redis aktyvuotas, PostgreSQL — ne. Sprendimas privalo kilti iš `common.js`
lygybės autoriteto ir padengti VISUS persistentinius backend'us.

Paveiktų reikšmių predikatas IŠMATUOTAS ir siauras: **reikšmėje bet kokiame gylyje yra
objektas, turintis `toJSON`** (`kanonizuoti()` renka nuosavus raktus ir jo nemato,
`JSON.stringify` jį kviečia). `Date` yra šio predikato atvejis, ne atskira klasė;
`Map`, `Set`, `NaN`, `Infinity`, `undefined` ir klasės be `toJSON` abiejose pusėse
virsta tuo pačiu ir į apimtį nepatenka.

⚠️ **PR-4 REGISTRAS YRA WRITE-ONLY — SPRENDIMAS, NE PRALEIDIMAS.**

Iš penkių sąlygų, priimtų kartu su variantu (b), PR-4 įgyvendina DVI: įrašas atsiranda
prieš `put()`, ir cleanup liečia tik savo bandymą. Trys likusios yra būtent tos, kurios
paverčia registrą VEIKIANČIU, ir visos trys yra PR-5 apimtis („Erasure ir registro
vartotojai"):

1. **erasure trina pagal registrą**, ne pagal `storage_key`;
2. **šlavėjas** neįsipareigotiems bandymams;
3. **retencija ≥ prikėlimo horizontai**, išvedama iš `revivalHorizonsMs()`.

⚠️ **PR-5 ŠLAVĖJUI REIKALINGA PRIELAIDA PADARYTA DB INVARIANTU (PR-4 pabaigoje).**

„Job'as turi daugiausia VIENĄ įsipareigotą bandymą" iki šio raundo buvo modulio
susitarimas `attemptRegistry.isipareigoti()` viduje. Spragą (du `committed` įrašai po
remonto) rado testas, ne konstrukcija — o testas įrodo nebuvimą tik ten, kur nuėjo.
Šlavėjas rems būtent šia prielaida: du įsipareigoti bandymai reikštų arba naudojamo
objekto ištrynimą, arba nebenaudojamo palikimą. Todėl pridėtas dalinis unikalus
indeksas `UNIQUE (job_id) WHERE busena = 'committed'` (migracija `1756400000000`) —
tas pats precedentas kaip PR-1, kur vientisumo metaduomenys tapo DB invariantu.

Pasekmė kodui: dalinio indekso atidėti negalima, tad perėjimas skaidomas į DU sakinius
(nuvertinimas, tada įsipareigojimas) toje pačioje transakcijoje — vieno `CASE` sakinio
eilučių tvarka neapibrėžta, ir jis kristų atsitiktinai.

⚠️ **KODĖL LANGAS NEPAVOJINGAS, IR KODĖL TAI NĖRA „UŽDARYTA ORPHAN PROBLEMA".**
External rašymas įsijungia TIK gavus `rasymoSaugykla`, o produkcinis prijungimas vyksta
PR-7. Skaitymo pusė (PR-5) atsiranda ANKSČIAU, nei kelias tampa pasiekiamas — write-only
langas niekada nepersidengia su diegimu, kuris realiai rašo external rezultatus.

⚠️ **IR TAI YRA PRIKLAUSOMYBĖ, NE TVARKOS SUTAPIMAS.**

**`rasymoSaugykla` produkcinis prijungimas negali įvykti anksčiau, nei registro skaitymo
pusė (erasure pagal registrą + šlavėjas).** Remtis PR numeracijos seka būtų prielaida:
jei PR-7 kada nors aplenktų PR-5 (pvz. dėl skubaus poreikio įjungti external saugyklą),
langas atsivertų TYLIAI, ir niekas to nesusietų su šiuo sprendimu. Todėl sąlyga
užrašoma kaip reikalavimas prijungimui, ne kaip pastaba apie eiliškumą.

⚠️ **BDAR PRASME TAI REIŠKIA:** iki PR-5 nutrūkęs procesas paliktų objektą, kurio
niekas nepašalins — registras jį UŽRAŠO, bet neskaito. Kol external rašymas
neprijungtas, tokių objektų atsirasti negali; nuo prijungimo momento (PR-7) skaitymo
pusė privalo jau egzistuoti. Tvarka yra garantijos dalis, ne patogumas.

**Ką palieka veikiantį:** external completion veikia `fs` backend'e; sargas
(`postgresStore.js:1623-1627`) **dar lieka**, nes erasure ir backup keliai
nepadengti (#157 to reikalauja eksplicitiškai).

**Failai**
- `backend/utils/jobStore/postgresStore.js` — `upsertResult()` → reference switch;
  `finishAtomic()` I/O tvarka
- `backend/utils/jobStore/common.js` — **neliečiamas** (autoritetas lieka)
- `backend/tests/artifactRoundTrip.test.js` (nauja, vietoje: inline+fs)
- `backend/tests/externalCompletion.integration.test.js` (nauja)

**I/O tvarka — DVIEJŲ PAKOPŲ** (#157 D4):
```
1. optimistic identity pre-check   (DB skaitymas, be užrakto, be I/O)
       │  checksum NESUTAMPA → einama į pilną kelią (2)
       │  checksum SUTAMPA   → praleidžiamas 2 žingsnis, einama TIESIAI į 3
       ▼
2. canonicalize → ArtifactStore.put() → head() verification
       ▼
3. trumpa DB transakcija: authoritative re-check / CAS → commit
       ▼
4. pralaimėjus arba rollback'inus → cleanup: trinamas TIK savas `attemptId`
```

⚠️ **CLEANUP TRINA TIK SAVO BANDYMĄ, IR TAI KONSTRUKCIJA, NE DRAUSMĖ.**

Su attempt-unique raktu pralaimėjęs fiziškai neturi kaip paliesti laimėtojo
objekto: raktai skirtingi. Sąlyginė patikra („ar kas nors referencina") tampa
nereikalinga — ne todėl, kad ją praleidžiame, o todėl, kad nebėra ką ja spręsti.

⚠️ **KODĖL ŠIS SKYRIUS PERRAŠYTAS DU KARTUS.** Pirmoji redakcija leido
besąlyginį trynimą su turinio adresu — tai būtų ištrynę laimėtojo objektą.
Antroji pridėjo sąlyginę patikrą po eilutės užraktu — bet ji neuždarė lenktynių,
kai konkurentas jau parašė objektą, o į transakciją dar neįėjo. Tik rakto schemos
pakeitimas pašalino klasę; abu ankstesni bandymai ją tik siaurino.

Istorinė alternatyva (turinio adresas + sąlyginis cleanup po užraktu) atrodytų
taip, ir ji čia paliekama kaip **atmestas** variantas:

```
BEGIN
  SELECT ... FROM jobs WHERE id = $1 FOR UPDATE      -- laukia, kol laimėtojas commit'ina
  SELECT storage_key FROM job_results WHERE job_id = $1
  jei storage_key = mūsų raktas  → NETRINAM (tai laimėtojo objektas)
  jei nuorodos nėra              → trinam (tikras orphan)
COMMIT
```

Užraktas ten būtinas: be jo pralaimėjęs galėtų patikrinti nuorodą PRIEŠ
laimėtojo commit'ą, pamatyti „nereferencuota" ir ištrinti objektą, kurį
laimėtojas po sekundės užregistruos. **Bet ir su užraktu jos nepakanka** — žr.
scenarijų žemiau.

⚠️ **BET UŽRAKTO NEPAKANKA, IR TAI ANTRA TO PATIES DEFEKTO REDAKCIJA** (Codex P1
antrą kartą, #289). Scenarijus, kurio sąlyginis cleanup NEUŽDARO:

```
A: put(raktas) ✓        B: put(raktas) ✓   (tas pats turinio adresas)
A: transakcija krenta
A: paima eilutės užraktą, nuorodos NĖRA  →  trina objektą
                        B: dar tik dabar įeina į transakciją, commit'ina nuorodą
                        →  B nuoroda rodo į IŠTRINTĄ raktą
```

Eilutės užraktas serializuoja tik tuos, kurie jau **įėjo** į transakciją; B
rašymas įvyko PRIEŠ ją. Vadinasi „jei nuorodos nėra → trinam" yra neteisinga
sąlyga: nuorodos nebuvimas nereiškia, kad objekto niekam nereikia — jis gali būti
reikalingas rašytojui, kuris dar nespėjo commit'inti.

**Sprendimas: rašymo kelias gauna ATTEMPT-UNIQUE raktą.**

| Vaidmuo | Reikšmė | Kodėl |
|---|---|---|
| Tapatybė | `sha256(kanoninisRezultatas)` **kolonoje** | idempotencijos fast-path, A2 |
| Objekto kelias | `results/<jobId>/<attemptId>.json` | vienas rašytojas — vienas objektas |

Su attempt-unique raktu A niekada neturi teisės liesti B objekto: jie skirtingi.
Cleanup tampa trivialus ir saugus — kiekvienas trina TIK savo attempt'ą, jei jo
nuoroda neįsipareigojo. Kaina: du identiški rezultatai užima du objektus, kol
retencija vieną pašalins. Tai pigiau nei bet kokia koordinavimo schema tarp
in-flight rašytojų, ir nereikalauja `list(prefix)` (A3).

⚠️ **TURINIO ADRESAS LIEKA — TIK NE OBJEKTO KELYJE.** `checksum` kolona toliau
neša tapatybę; pasikeičia tik tai, kad ji nebėra objekto vardas. Tai tiesiogiai
atitinka A2 ribą „checksum niekada neišvedamas iš object key" — dabar ji galioja
ir atvirkščiai: object key neišvedamas iš checksum'o.

### ✅ PRIIMTAS PR-4 SPRENDIMAS: orphan'ai su attempt-unique raktu

Rakto schemos pakeitimas uždarė duomenų praradimą, bet **atidarė kitą klausimą, ir
jį reikia priimti eksplicitiškai, ne praslysti pro šalį.**

Su turinio adresu orphan'ai buvo iš dalies saviorganizuoti: pakartotinis tas pats
rezultatas taikėsi į tą patį raktą, tad šiukšlė nesidaugino. Su attempt-unique
raktu **kiekvienas kritęs bandymas palieka unikaliai pavadintą objektą**, o
procesas, kritęs tarp `put()` ir cleanup, palieka objektą, kurio nerodo nė viena
DB eilutė.

⚠️ **AŠTRIAUSIA FORMA: toks objektas išgyvena job'o IŠTRYNIMĄ.** Erasure eina per
`job_results.storage_key`; nuorodos nėra, tad nėra ko trinti — o objekte guli
transkripcija. Tai nebe šiukšlė, o GDPR klausimas, ir jis atsirado dėl mano rakto
schemos sprendimo, ne dėl #157 reikalavimo.

⚠️ **TAS PATS REIŠKINYS JAU PASIRODĖ TRIS KARTUS.** Prieš sprendžiant verta
matyti visus tris veidus — jie skiriasi tik tuo, kur objektas atsiranda:

| # | Kaip atsiranda | Kada |
|---|---|---|
| 1 | attempt-unique raktas: kritęs bandymas palieka savo objektą | PR-4 rašymas |
| 2 | nutrūkęs cleanup tarp `put()` ir DB commit'o | PR-4 rašymas |
| 3 | `fs` laikinas `.tmp` failas, likęs po nutrūkusio proceso | PR-2 `fsStore` |

Visais trim atvejais rezultatas tas pats: **nereferencuotas objektas su
transkripcija**, kurio nepasiekia nei erasure, nei DB kryptimi orientuotas
skenavimas (A3).

⚠️ **TODĖL PR-2 `.tmp` VALYMO MECHANIZMO NEKURIA.** Atskiras sprendimas būtų
trečias taškinis vaistas tam pačiam reiškiniui. Jei PR-4 pasirenkamas variantas
(b) — patvarus bandymų registras — jis dengia ir šitą: laikinas failas tampa
REGISTRUOTU bandymu, tad matomas DB kryptimi kaip ir visi kiti.

Trys variantai PR-4:

| | Variantas | Kaina |
|---|---|---|
| a | Erasure trina pagal **prefiksą** (`results/<jobId>/`) | Tai `list`-ekvivalentas: A3 riba turėtų būti PERRAŠYTA, ne apeita per kitą metodo vardą |
| b | **Patvarus bandymo registras:** `attemptId` įrašomas į DB PRIEŠ `put()` | Orphan tampa matomas DB kryptimi; kaina — vienas `INSERT` prieš kiekvieną rašymą |
| c | Riba pripažįstama ir fiksuojama | `docs/artefact-lifecycle.md` + follow-up issue; GDPR pusėje silpniausias |

✅ **SPRENDIMAS: (b) — PATVARUS BANDYMŲ REGISTRAS.**

Ji vienintelė išlaiko A3 („DB kryptis") nepakeistą ir tuo pat metu padaro orphan'ą
aptinkamu: jei `attemptId` yra registre, bet nėra `job_results` nuorodos, objektas
turi savininką ir adresą. (a) reikštų tylų A3 apėjimą — `list(prefix)` grįžtų kitu
vardu; (c) paliktų transkripciją saugykloje po ištrynimo.

⚠️ **KODĖL (b) LAIMĖJO, O NE „ATRODĖ SAUGIAUSIA":** ji vienintelė paverčia A3 ribą iš
ŽINOMOS SPRAGOS į PILNĄ GARANTIJĄ tam, ką patys parašėme. „Objektas yra, DB nerodo"
nustoja egzistuoti kaip klasė, ir `list(prefix)` tampa nereikalingas ne dėl
susitarimo, o dėl konstrukcijos.

**Ribos, kurios yra sprendimo dalis:**

- įrašas atsiranda **PRIEŠ `put()`**, ne po jo — po reikštų tą patį langą, tik
  siauresnį;
- registras dengia **visus tris veidus** (lentelė aukščiau): attempt-unique raktus,
  nutrūkusį cleanup tarp `put()` ir commit'o ir `fs` `.tmp` likučius. Trečiajam tai
  reiškia, kad laikinas vardas irgi registruojamas arba IŠVEDAMAS iš registruoto
  bandymo — kitaip lieka ketvirtas veidas;

  ✅ **ĮVYKDYTA PR-4 PABAIGOJE (`REOPENED`, Codex #294).** Iki tol vardas buvo
  atsitiktinis (`fsStore.js:407`), tad sąlyga liko neįgyvendinta ir ketvirtas veidas
  egzistavo: registre — tik galutinis raktas. Dabar vardą duoda `laikinasVardas(raktas)`,
  ir šlavėjas (PR-5) jį apskaičiuoja iš `storage_key`; antros registro eilutės nereikia.

  ⚠️ **Vardas NĖRA `<raktas>.tmp`, ir priežastis išmatuota:** segmento riba (255 baitų)
  sutampa su `NAME_MAX`, tad bet koks sufiksas raktą, kurį riba priėmė, paverstų
  `ENAMETOOLONG` (255 + `.tmp` = 259). Fiksuoto ilgio santrauka iš rakto tenkina abu
  reikalavimus: išvedama ir neauga;
- **erasure trina pagal REGISTRĄ, ne pagal `storage_key`**: job'o ištrynimas pašalina
  visus to job'o bandymų objektus, ne tik laimėjusio;
- **retencija ≥ eilės prikėlimo horizontai**, IŠVEDAMA iš `revivalHorizonsMs()`, ne
  surašoma — ta pati taisyklė kaip 7.5a ištrynimo žymoms;
- kaina: vienas papildomas DB rašymas per job'o užbaigimą.

⚠️ **KO REGISTRAS NEDENGIA:** objektai, atsiradę NE per mūsų rašymo kelią (rankinis
kopijavimas, atkūrimas į kitą prefiksą), registre neatsiras. Riba užrašyta
`docs/artefact-lifecycle.md` skyriuje „Ko šis etapas NEAPIMA".

⚠️ **SPRENDIMAS PRIIMAMAS PR-4 PRADŽIOJE, NE PABAIGOJE.** Jis keičia rašymo kelio
formą (registras prieš `put()`), tad įterptas vėliau reikštų perrašymą.

Iki tada lieka ir senoji riba: objektas, parašytas proceso, kuris krito prieš bet
kokią DB transakciją, be varianto (b) neturi jokio detektoriaus — DB krypties
skenavimas jo nemato pagal apibrėžimą.

`put()` vyksta **prieš** `inTransaction()`, ne jo viduje: tai išsprendžia
`rezultatoEilute()` po `FOR UPDATE OF j` (`postgresStore.js:1034-1041`) be
tinklo I/O po užraktu.

⚠️ **PR-4 NESIŠAKOJA PAGAL BACKEND'O VARDĄ — TIK PAGAL `reference`.**

`put()` grąžina `reference === null` inline atveju ir adresą external atveju. Tas
pats predikatas, kurį PR-5 naudoja ištrynimui, dengia ir PR-4 rašymo kelią:
`null` → **išorinio objekto nėra, tad nėra nei cleanup, nei orphan**. Šakojimasis
pagal `backend` vardą būtų trečia tos pačios tiesos interpretacija — užrašoma
dabar, kol atrodo akivaizdu.

⚠️ **ANKSTESNĖ ŠIO SAKINIO REDAKCIJA BUVO KLAIDINGA, IR TAISOMA FORMULUOTĖ, NE
GYNYBA** (Codex, #290).

Ji teigė, kad `reference === null` reiškia ir „pralaimėjusio bandymo nėra". Tai
netiesa: du bandymai tam pačiam job'ui naudoja **tą patį `job_id`**, o
`ON CONFLICT (job_id) DO UPDATE SET payload` perrašo nugalėtojo rezultatą **dar
prieš** completion CAS. Išorinio objekto tikrai nėra — bet svetimo rezultato
perrašymas įvyksta, ir jokia nuoroda apie tai nieko nesako.

⚠️ **IŠ TO SEKA PR-4 REIKALAVIMAS:** inline rašymas privalo vykti **toje pačioje
transakcijoje / CAS** kaip completion, arba bandymai gauna izoliuotą saugojimą.
Sprendimas priimamas PR-4, ne čia; PR-2 kode šito nesprendžiame.

⚠️ **KĄ PREDIKATAS TOLIAU REIŠKIA:** `reference === null` galioja **cleanup ir
orphan** klausimui (išorinio objekto nėra, tad nėra ko trinti ir nėra kam pasimesti)
— bet NE „pralaimėjusio bandymo nėra". Riba užrašoma, kad kitas skaitytojas
nepaimtų platesnės reikšmės iš siauresnio fakto.

⚠️ **PRE-CHECK NĖRA IR LYGYBĖS VERDIKTAS** (Codex, #289).

Body sako: checksum yra **fast-path**, o galutinį „tas pats rezultatas" sprendžia
`kanoninisRezultatas()`. Ankstesnė šio plano seka tą taisyklę apeidavo — grąžindavo
no-op tiesiai iš pre-check'o, t. y. verdiktą priimdavo vien digest'as. Todėl seka
perrašyta: sutapęs checksum praleidžia tik **`put()`**, ne DB patvirtinimą.

| Pre-check | Ką reiškia | Kur einama |
|---|---|---|
| checksum **nesutampa** | rezultatai TIKRAI skirtingi — digest čia saugus | pilnas kelias su `put()` |
| checksum **sutampa** | greita šaka, ne verdiktas | authoritative re-check transakcijoje, `put()` praleidžiamas |

⚠️ **PRIEŽASTIS NĖRA sha256 KOLIZIJA.** Ji teorinė, ir remtis ja būtų silpna.
Tikroji priežastis — **metaduomenys gali nesutapti su turiniu**: `checksum`
aprašo tai, kas buvo įrašyta, ne tai, kas objekte guli dabar. Sprendimą priimti
gali tik DB pusėje matoma eilutės būsena.

Pilna kanoninė lygybė reikalinga TIK ten, kur rezultatas vis tiek skaitomas —
selective hydration lieka nepaliesta, ir pakartotinis `finish()` external turinio
neskaito.

⚠️ **BET NO-OP NEGALI BŪTI SKELBIAMAS NEPATIKRINUS, AR OBJEKTAS DAR YRA**
(Codex, #289). Sutapęs checksum sako tik tiek, kad **metaduomenys** sutampa;
objektas per tą laiką galėjo dingti, būti perrašytas ar sugadintas. Tokiu atveju
ankstesnė seka grąžindavo sėkmę virš pakibusios nuorodos — `completed` job'as be
naudojamo rezultato.

Todėl no-op šaka turi **du** reikalavimus:

1. persistintas `checksum` sutampa su įeinančiu, IR
2. `head()` patvirtina, kad objektas egzistuoja ir jo dydis atitinka persistintą
   `bytes`.

Neišlaikius (2), tai **nebe pakartojimas, o remontas**: einama į pilną kelią,
rašomas naujas `attemptId` objektas ir perjungiama nuoroda. Turinys ir toliau
NESKAITOMAS — `head()` yra metadata operacija, leidžiama visuose keliuose (žr.
PR-2 trijų lygių lentelę), tad selective hydration lieka nepaliesta.

⚠️ Riba, kurią tai palieka: `head()` be checksum'o (pvz. `fs`) sugadinto, bet
to paties dydžio objekto neaptiks. Pilną `verify()` čia dėti būtų per brangu —
kiekvienas pakartojimas skaitytų visą artefaktą. Ta klasė lieka restore
verifikacijai (PR-7), ir tai užrašoma, ne nutylima.

⚠️ **PRE-CHECK NĖRA CONCURRENCY AUTORITETAS, IR TAI RAŠOMA KODE, NE TIK ČIA.**
Tarp 1 ir 3 žingsnio kitas worker'is gali laimėti, tad sprendimą priima **DB
pusėje matoma eilutės būsena** (3 žingsnis), ne prieš I/O perskaityta jos kopija.
Pre-check klysta tik **viena kryptimi**: leidžia nereikalingą rašymą, kurį
re-check atmeta. Priešinga klaida — patvirtinti rezultatą vien pre-check pagrindu —
neįmanoma pagal konstrukciją, nes pre-check kelias niekada nerašo į `job_results`.

⚠️ **KODĖL NO-OP GRĮŽTA PRIEŠ `put()`, O NE PRIEŠ REFERENCE PERRAŠYMĄ.**
Argumentas „tas pats raktas, tad perrašymas nekenkia" padarytų elgesį priklausomą
nuo saugyklos overwrite semantikos: S3 versijavimas, `fs` `rename` ir būsimas
backend'as ją turi skirtingą. Tapatybės sprendimas privalo būti mūsų, ne
saugyklos.

⚠️ **SU ATTEMPT-UNIQUE RAKTU ŠIS ARGUMENTAS TAPO DAR STIPRESNIS.** Perėjus nuo
turinio adreso (delta 15), „tas pats raktas" nebeegzistuoja apskritai: kiekvienas
bandymas rašo į savo objektą. Vadinasi be pre-check kiekvienas pakartotinis
`finish()` sukurtų NAUJĄ objektą, o ne perrašytų esamą — šiukšlė, kurios
retencija turėtų valyti. Pre-check yra vienintelis dalykas, neleidžiantis tam
įvykti, tad jo mutacija (`put` skaitiklis 2 vietoj 1) lieka galiojanti ir po
rakto schemos pakeitimo.

**Lygybės paritetas.** `inline` kelias lygina kanonines eilutes, external —
persistintą checksum'ą. Tas pats **scenarijų rinkinys** (`tests/helpers/rezultatuPoros.js`)
paleidžiamas visiems trims backend'ams ir tikrina, kad verdiktas („tas pats" /
„skirtingas") sutampa. Checksum yra **fast-path**, ne semantika: nesutapus,
laimi `kanoninisRezultatas()`, ir toks nesutapimas testuose fiksuojamas kaip
defektas, ne kaip toleruojama riba.

**Reference switch SQL forma (mano sprendimas):**
`INSERT ... ON CONFLICT (job_id) DO UPDATE SET storage_type=, storage_key=, payload=, bytes=, checksum=`
— vienas sakinys, viena eilutė, jokios commit'intos tarpinės būsenos. `DELETE`+`INSERT`
atmetu ne dėl atomiškumo (transakcijoje jis lygiavertis), o dėl to, kad tarp jų
eilutė **neegzistuoja**, ir lygiagretus `SELECT` mato „rezultato nėra" vietoj
„rezultatas senas" — tai keistų `finishAtomic` klasifikaciją.

**DoD**
- „Reference switch (`upsertResult()` ar jo įpėdinis) `storage_type`, `storage_key` ir `payload` keičia vienu atominiu DB perėjimu…"
- „Apibrėžta ir testais įrodyta `ArtifactStore` round-trip ištikimybė…"
- „Pakartotinis `finish(COMPLETED)` su tuo pačiu external rezultatu yra tikras no-op: version nedidėja, reference neperrašomas ir **`ArtifactStore.put()` nekviečiamas apskritai**…"
- „Lygybės paritetas: jei external kelias idempotentiškumą sprendžia per checksum, bendras scenarijų rinkinys įrodo, kad inline ir external verdiktai sutampa toms pačioms rezultatų poroms; checksum neišvedamas iš object key."
- „Authoritative re-check: pre-check rezultatas nėra concurrency autoritetas; du lygiagretūs `finish()` sprendžiami DB pusėje po external I/O."
- „Skirtingas loginis rezultatas negali tyliai perrašyti jau completed rezultato."
- „External object write nevyksta atviros PostgreSQL transakcijos / job row lock metu; DB commit nesėkmė po object write sukelia saugų orphan cleanup."
- „Concurrency testas su dviem lygiagrečiais `finish(COMPLETED)`…"
- „External object key yra collision-safe / immutable konkrečiam rezultatui arba write attempt."

**§9.1**
| Sargas | Mutacija | Krenta? |
|---|---|---|
| **pre-check** (praleidžia `put()`) | pašalinam pre-check šaką | taip — `put` skaitiklis 2 vietoj 1, nors tapatybė sutampa |
| pre-check NĖRA verdiktas | grąžinam no-op tiesiai iš pre-check'o | taip — testas su „checksum sutampa, bet eilutė pakeista" gauna sėkmę be DB patvirtinimo |
| no-op reference perrašymas | nuimam re-check sąlygą | taip — `updated_at`/version pasikeičia |
| version nedidinamas | nuimam `IS DISTINCT FROM` sąlygą | taip — version 2 vietoj 1 |
| authoritative re-check | paliekam tik pre-check | taip — lenktynių testas duoda du skirtingus rezultatus toje pačioje eilutėje |
| I/O ne po užraktu | keliam `put()` į `inTransaction()` | **ne automatiškai** — žr. žemiau |
| cleanup trina TIK savo `attemptId` | trinam pagal `jobId` prefiksą | taip — lygiagretus testas: laimėtojo objekto nebelieka, nors jo eilutė commit'inta |
| cleanup apskritai vyksta | pašalinam `catch` | taip — pralaimėjusio bandymo objektas lieka saugykloje |
| commit'intas bandymas NELIEČIAMAS | trinam po commit'o | taip — `head()` po sėkmingo `finish()` grąžina `null` |

⚠️ **MUTACIJOS SUDERINTOS SU ATTEMPT-UNIQUE RAKTU** (Codex, #289). Ankstesnė
lentelė reikalavo sąlyginio cleanup po `FOR UPDATE` ir tikėjosi, kad pralaimėjęs
ištrins laimėtojo objektą. Su skirtingais raktais tos mutacijos nebeatkuria
aprašyto gedimo — jos arba neveikia, arba skatina grąžinti nebeegzistuojantį
bendro rakto koordinavimą. Pakeista tuo, ką dabar reikia įrodyti: kad cleanup
liečia TIK savo bandymą.

⚠️ **„I/O ne po užraktu" negali būti įrodyta grep'u** (§9.2), o elgesio testas
reikalauja stebimo užrakto. Sprendimas: `ArtifactStore` dublis, kurio `put()`
bando **antra jungtimi** perskaityti tą pačią `jobs` eilutę su
`SELECT ... FOR UPDATE NOWAIT`. Jei `put()` vyksta po užraktu — `55P03`, testas
krenta. Tai elgesio, ne teksto, įrodymas; kaina — integracinis testas.

⚠️ **UNVERIFIED:** dviejų lygiagrečių `finish()` lenktynės. Vienas žalias
paleidimas nieko neįrodo (§14.1). Testas kartojamas N kartų su barjeru, bet
verdiktas lieka „nepaneigta", ne „įrodyta"; įvardijama PR aprašyme.

---

### PR-5 — Erasure ir registro vartotojai

**Ką palieka veikiantį:** ištrynimas šalina ir external objektą; registras
nebemeluoja apie saugojimo vietą.

---

⚠️ **ĮĖJIMO SĄLYGOS — VISOS, VIENOJE VIETOJE (surinkta PR-5 pradžioje).**

Tas pats šablonas kaip PR-4 („ĮĖJIMO SĄLYGOS — ABI PRIIMTOS, VIENOJE VIETOJE"), ir dėl
tos pačios priežasties: sąlygos priimtos skirtinguose raunduose ir gyvena skirtinguose
skyriuose, o PR-5 pradžioje jų tektų ieškoti. **PR-5 apimtis paaugo dviejuose
paskutiniuose PR-4 raunduose**, tad senas šio skyriaus vaizdas nebėra pilnas.

| # | Sąlyga | Kur priimta |
|---|---|---|
| 1 | **Erasure trina PAGAL REGISTRĄ**, ne pagal `job_results.storage_key` — job'o ištrynimas šalina VISŲ to job'o bandymų objektus, ne tik laimėjusio | variantas (b), orphan skyrius |
| 2 | **Šlavėjas** neįsipareigotiems bandymams (`busena <> 'committed'`) | variantas (b), orphan skyrius |
| 3 | **Retencija ribojama BŪSENA IR amžiumi:** horizontas iš `revivalHorizonsMs()` yra apatinė riba, bet eilutė, kurios objektas referencuotas **ARBA** kurios job'as turi neišspręstą ištrynimo žymą, pagal amžių nešalinama NIEKADA | variantas (b) + PR-5 pradžios peržiūra |
| 4 | **Šlavėjas zonduoja ABU vardus** (laikiną ir galutinį); „nė vieno nėra" = sėkmė | #294 uždarymas — žr. skyrių iškart žemiau |
| 4a | **Šlavėjas neliečia VYKSTANČIO rašymo:** `pending` eilutei horizontas turi atskirą „maksimalios rašymo trukmės" narį, neišvestą iš `revivalHorizonsMs()` | PR-5 peržiūra — determinizmo pasekmė |
| 4b | **Fail-closed praleidimas MATOMAS:** skaitiklis + `log.warn` suvestinėje, 7.5a precedentu (`retentionSweeper.js:269-274`) | PR-5 peržiūra |
| 4c | **„Maksimali rašymo trukmė" užrašoma kaip EURISTIKA** su kilme ir galiojimo pabaiga, `MAX_SEGMENTO_BAITAI` šablonu | PR-5 peržiūra |
| 3a | **Žymų saugyklos neatitikimas — ŽINGSNIO lygio būsena**, pranešama vieną kartą, ne kaip N praleistų eilučių | PR-5 peržiūra |
| 4d | **Abu vardai rasti = INVARIANTO PAŽEIDIMAS**, pranešamas, o ne tyliai ištrinamas | PR-5 peržiūra |
| 5 | **Per-row `storage_type` visiems trims vartotojams**; `fs` turi laikiną objektą, `s3` — ne, ir tai irgi per-row klausimas | A4 + #294 |
| 6 | **Store lygmens metodas visoms nuorodoms**, ne `job.resultStorage` laukas | PR-3 peržiūra (žr. „PATAISYTA" žemiau) |
| 7 | **`reference !== null`** → objektas privalo būti pašalintas ir tai patvirtinta; `reference === null` → eilutės ištrynimas IR YRA ištrynimas | kontraktas, ne PR-5 |
| 8 | **„Job'as turi daugiausia VIENĄ įsipareigotą bandymą" yra DB invariantas** (`UNIQUE (job_id) WHERE busena = 'committed'`, migracija `1756400000000`) — šlavėjas gali juo REMTIS, ne tikrinti | PR-4 pabaiga |

⚠️ **KAIP ŠIS SĄRAŠAS UŽDAROMAS — DVYLIKA SĄLYGŲ PATI SAVAIME YRA RIZIKA.**

Sąrašas per tris raundus paaugo nuo trijų iki dvylikos, ir jis turi tą pačią savybę kaip
bet kuris rankinis sąrašas: **jį galima įvykdyti nepilnai, ir niekas nekris.** Šlavėjas
gali praeiti visus testus, uždaryti dešimt sąlygų iš dvylikos, ir tai atrodys kaip sėkmė.

Atsakymas nėra dar viena taisyklė: **šlavėjo užbaigimo ataskaita eina per sąrašą punktas
po punkto** — dvylika eilučių, kiekviena su įrodymu arba `UNVERIFIED`. Ta pati forma kaip
PR-1 DoD citatos. Tai uždaro vienintelį būdą, kuriuo šis sąrašas gali suklysti.

⚠️ **TRYS POROS NĖRA NEPRIKLAUSOMOS — RAŠOMOS KARTU, NE EILĖS TVARKA.**

| Pora | Kodėl kartu |
|---|---|
| **4a + 4b** | 4a fail-closed SUKURIA tai, ką 4b turi matyti. Vien 4a — sistema tyli; vien 4b — nėra ko rodyti |
| **3a + 8** | Jei žymų saugykla „kitokia", predikato antra šaka neveikia, ir lieka klausimas, ar sąlygos 8 pakanka — žr. atsakymą žemiau |
| **4 + 4d** | Tai TAS PATS kodas su dviem verdiktais. Parašius atskirai lengva gauti šaką, kuri trina, ir šaką, kuri praneša, nesutariančias dėl tos pačios būsenos |

⚠️ **ATSAKYMAS Į 3a + 8 KLAUSIMĄ: SĄLYGA 8 NĖRA PAKAITALAS, TAD ŠLAVĖJAS NEDIRBA.**

Kyla natūralus klausimas, ar praradus žymų šaką pakanka sąlygos 8 (DB invariantas
„daugiausia vienas įsipareigotas"). **Nepakanka, ir priežastis struktūrinė:** sąlyga 8
sako, kuris bandymas yra REFERENCUOTAS, tad ji gina būtent tuos objektus, kurie ir taip
apsaugoti pirmąja predikato šaka. Šlavėjo dalykas yra priešingas — NEREFERENCUOTI
bandymai, kuriems sąlyga 8 nepasako nieko.

Todėl, kai žymų saugykla nepasiekiama ar kitokia, šlavėjas **nedirba visai** (žingsnio
lygio fail-closed), o ne šluoja su viena apsauga iš dviejų. Tai ir yra 3a „žingsnio lygio
būsenos" praktinė prasmė: ne tik pranešimo forma, bet ir apimtis.

✅ **KĄ PR-3/PR-4 JAU PADARĖ — NEBEKARTOTI (patikrinta kode, ne prisiminta):**

- metaduomenų `SELECT` jau neša rezultato nuorodą: `SELECT_JOB_META` turi
  `result_storage_type`, `result_storage_key`, `result_bytes`, `result_checksum`
  (`postgresStore.js:625-635`) — **be `payload`**, tad hidratacijos riba nepažeista.
  Skyriaus tekstas žemiau („BET ŠIANDIEN NĖ VIENAS IŠ TRIJŲ NETURI IŠ KUR TO SUŽINOTI")
  aprašo būseną PRIEŠ PR-3 ir paliktas kaip sprendimo pagrindimas, ne kaip dabartis;
- `laikinasVardas(raktas)` eksportuotas iš `utils/artifactStore/fsStore.js`;
- registro rašymo pusė (`registruoti`, `pazymeti`, `isipareigoti`, `joboBandymai`) veikia
  ir yra padengta; PR-5 prideda VARTOTOJUS, ne registrą.

⚠️ **SĄLYGA 3 PATIKSLINTA: HORIZONTO VIENO NEUŽTENKA.**

Pradinė formuluotė („retencija ≥ prikėlimo horizontai") kalba tik apie AMŽIŲ. Bet
`listResultArtifacts()` `busena: null` atvejis parodo, kad registro eilutė gali dingti,
kol objektas dar gyvas ir referencuotas — o tada objekto atrandamumas priklauso VIEN nuo
`job_results` eilutės. Ji turi `ON DELETE CASCADE` nuo `jobs`; registras FK sąmoningai
neturi būtent tam, kad išgyventų. Vadinasi galimas derinys, kuriame **abi** rodyklės
dingsta: retencija pašalino bandymo eilutę anksčiau, o vėliau job'as ištrintas keliu,
kuris neina per `listResultArtifacts()`.

**Predikatas: bandymo eilutė, kurios `storage_key` yra gyvoje `job_results` eilutėje,
retencijai NEATIDUODAMA — nepriklausomai nuo amžiaus.** Tai ta pati taisyklė, kurią 7.5a
jau priėmė ištrynimo žymoms: retencija priklauso nuo BŪSENOS, ne tik nuo amžiaus.

⚠️ Predikatas formuluojamas per NUORODĄ, ne per `busena = 'committed'`, ir skirtumas
nėra kosmetinis. Migracijos indeksas `job_result_attempts_valytini`
(`WHERE busena <> 'committed'`) šiandien atrenka kandidatus ir įsipareigotų eilučių
nepaima — bet tai indekso, t. y. PAIEŠKOS, savybė, ne sargas. Būsena ir nuoroda gali
išsiskirti (ranka redaguota eilutė, atkūrimas iš dviejų skirtingų momentų), o klausimas,
į kurį retencija privalo atsakyti, yra „ar ši eilutė yra vienintelis likęs adresas", ne
„kokia jos būsena".

⚠️ **BET VIEN NUORODOS NEUŽTENKA: APSAUGA DINGTŲ TADA, KAI JOS LABIAUSIAI REIKIA.**

Ištrynimas NAIKINA nuorodas. `job_results` turi `ON DELETE CASCADE` nuo `jobs`, tad
pašalinus job'o eilutę visos to job'o bandymų eilutės vienu metu netenka apsaugos.
Normaliame kelyje tai nekenkia — objektai šalinami pirmi, job'o eilutė paskutinė. Bet
daliniame gedime seka yra tokia:

1. vienas `delete()` grąžina klaidą, o job'o eilutė vis tiek pašalinama (arba jau buvo
   pašalinta kitu keliu);
2. nuorodų nebėra → bandymų eilutės nebeapsaugotos;
3. retencija po horizonto jas pašalina;
4. `deletionRetry` grįžta prie job'o, PAŽYMĖTO ištrynimui, ir nebeturi iš kur sužinoti
   adresų;
5. objektas lieka saugykloje amžiams — be nuorodos, be registro eilutės, be
   `list(prefix)`.

Tai TA PATI forma, dėl kurios registras FK į `jobs` sąmoningai neturi („`CASCADE`
pašalintų eilutę BŪTENT tuo momentu, kai ji reikalinga"). Predikatui, remiantis tuo pačiu
ryšiu, tas efektas grįžtų ne per FK, o pro galines duris.

**Todėl apsauga simetriška tam, kas jau įrodyta apie tvarką: ją teikia ir IŠTRYNIMO
ŽYMA.** Žyma rašoma PRIEŠ šalinimą, tad ji yra patvarus signalas, išgyvenantis nuorodos
dingimą:

> bandymo eilutė nešalinama pagal amžių, jei jos `storage_key` yra gyvoje `job_results`
> eilutėje **ARBA** jos job'as turi neišspręstą ištrynimo žymą
> (`erasure_marks.status <> 'deleted'`).

Antroji sąlyga pati savaime pasibaigia: žyma uždaroma, kai ištrynimas patvirtinamas, ir
tada eilutė teisėtai tampa valytina. Apsauga nėra amžina — ji trunka lygiai tol, kol
ištrynimas neišspręstas.

⚠️ **SĄLYGA 3a: KONFIGŪRACIJOS NEATITIKIMAS NĖRA „NORMALUS FAIL-CLOSED".**

Antroji predikato šaka reiškia, kad šlavėjas skaito `deletionTombstones`, o tos saugyklos
backend'as renkasi **automatiškai** — `pasirinktiBackend()` yra
`arNurodytaPostgres(env) ? "postgres" : "memory"` (`deletionTombstones/index.js:80-82`).
Tai vienintelis toks komponentas iš keturių (#245).

Iš to seka derinys, kurio negalima praleisti: jei `jobStore` yra PostgreSQL, o žymų
konfigūracija skiriasi (kitas taikinys, `PG*` ir `DATABASE_URL` neatitikimas), fail-closed
suveiks KIEKVIENAI eilutei — ir šlavėjas **niekada nieko nešluos, tyliai**, nes kiekvienos
eilutės žymos statusas bus „nežinau".

Tai ta pati klasė kaip 4b, bet KITO MASTO: 4b praleidžia atskiras eilutes, o čia
fail-closed padengia VISĄ šlavimą. Todėl šlavėjas privalo skirti du dalykus:

| Būsena | Kaip pranešama |
|---|---|
| atskira eilutė praleista (senas `created_at`, vykstantis rašymas) | skaitiklis suvestinėje (4b) |
| **žymų saugykla nepasiekiama arba kitokia** | **žingsnio lygio būsena, pranešama VIENĄ kartą aiškiai** — ne kaip N praleistų eilučių |

Priešingu atveju konfigūracijos klaida atrodys kaip normalus fail-closed darbas, ir
skaitiklis, į kurį niekas nežiūri, bus vienintelis skirtumas.

⚠️ **IR SUVESTINĖJE TAI PRIVALO BŪTI ATSKIRA REIKŠMĖ, NE NULIS.**

`runRetentionSweep()` grąžina suvestinę, ir „šis žingsnis NEVYKDYTAS" joje turi turėti
savo reikšmę. **Nulis reiškia „nieko nebuvo", o čia reiškia „nežinau, ar buvo"** — ta pati
riba kaip fasado `null` (`listResultArtifacts()`: „nežinau, netrink"). Sulietus abu,
sustabdytas žingsnis atrodytų kaip tuščias, o tai tiksliai ta būsena, kurios 3a ir vengia:
konfigūracijos klaida, atrodanti kaip normalus darbas.

⚠️ **IŠVESTINĖ SĄLYGA, KURIĄ ŠIS PREDIKATAS UŽDEDA ŠLAVĖJUI.** `erasure_marks` gyvena
toje pačioje bazėje kaip `job_result_attempts` (tos pačios migracijos), tad predikatas
yra VIENAS `SQL` sakinys, o ne dviejų saugyklų palyginimas — tai svarbu, nes lyginant per
programą tarp dviejų skaitymų liktų langas. Bet žymų fasadas gali veikti ATMINTIES
režimu (`pasirinktiBackend(env) === "memory"`); tada lentelė egzistuoja, bet tuščia, ir
`OR` sąlyga neapsaugotų NIEKO. Vadinasi šlavėjas privalo būti fail-closed: **jei žymų
saugykla nėra `postgres`, valymas pagal amžių NEVYKDOMAS.** Praleidus tai, apsauga
atrodytų veikianti ir tyliai negaliotų — ta pati klasė kaip „`[]` reiškia nėra ko
trinti".

⚠️ **ŽINOMAS LIEKAMASIS DARBAS (ne šio PR apimtis, bet užrašomas): „ANTRA SĄRAŠO
KOPIJA" YRA KLASĖ, NE TRYS ATVEJAI.**

PR-5 pradžioje CI davė tris radinius, ir visi trys buvo ta pati forma: antra to paties
sąrašo ar skaičiaus kopija (`restoredJobStore` būtinų metodų sąrašas; metodų skaičius
`postgresStore.integration`; skaičius testo varde). Antrasis ypač iškalbingas —
komentaras dubliavimą PRIPAŽINO ir nurodė „keičiamas abiejose", ir vis tiek atsiliko
antrą kartą. **Nurodymas nėra mechanizmas** (§19.5, patvirtinta eksperimentu).

Taisymai buvo taškiniai: dvi kopijos suvienytos, viena pašalinta. Klasė lieka atvira —
trečia kopija gali atsirasti rytoj, ir niekas nekris, kol ji neatsiliks. Struktūrinis
variantas: **`BUTINI_SYSTEM_METODAI` IŠVEDAMAS iš kontrakto rinkinio metodų aibės**, o ne
laikomas atskira konstanta. Nedaroma dabar (keistų `jobErasure` reikalavimų šaltinį
viduryje PR-5), bet įrašoma, nes ši klasė projekte kartojasi ne pirmą kartą.

⚠️ **KĄ PR-5 VIS DAR PRIVALO ĮRODYTI PATS:** `joboBandymai()` iki šiol nekviečiamas iš
produkcinio kodo — jis buvo parašytas PR-4 ir laukė šio PR. Tol, kol jį kviečia tik
testai, „erasure trina pagal registrą" yra dokumentacija, ne savybė.

---

⚠️ **ĮĖJIMO SĄLYGA (4): ŠLAVĖJAS PRIVALO BANDYTI ABU VARDUS** (#294 uždarymas).

PR-4 eksportavo `laikinasVardas(raktas)` (`utils/artifactStore/fsStore.js`) būtent tam,
kad šlavėjas laikino failo vardą apskaičiuotų iš registro `storage_key`. Bet **iš
`pending` eilutės neįmanoma pasakyti, kurioje `rename` pusėje procesas nutrūko**:

| Kada nutrūko | Kas saugykloje egzistuoja |
|---|---|
| prieš `rename` | **tik** `laikinasVardas(storage_key)` |
| po `rename`, prieš commit'ą | **tik** `storage_key` |
| po cleanup arba jam nespėjus prasidėti | nė vieno |

Vadinasi šlavėjas tikrina ABU adresus, o „nė vieno nėra" yra **sėkmė**, ne gedimas:
eilutė tada tiesiog uždaroma. Vieno adreso tikrinimas praleistų pusę atvejų, o testas su
vienu scenarijumi liktų žalias — todėl PR-5 testai privalo dengti abi puses atskirai.

⚠️ **KETVIRTAS DERINYS — ABU RASTI — YRA INVARIANTO PAŽEIDIMAS, NE ŠALINIMO ATVEJIS.**

Radus IR laikinąjį, IR galutinį objektą, reikštų, kad `rename` neįvyko, o ankstesnis
bandymas TUO PAČIU raktu paliko galutinį objektą. Su attempt-unique raktais
(`results/<jobId>/<attemptId>.json`) to būti negali: kiekvienas bandymas turi savo adresą.

Todėl šlavėjas šio atvejo **netyli ir abiejų neištrina** — jis praneša jį kaip invarianto
pažeidimą. Jei kada nors rakto schema pasikeis (pvz. į turinio adresą, kuris jau kartą
buvo atmestas), tai bus PIRMAS signalas — ir vienintelis, nes `list(prefix)` pagal A3
nėra.

⚠️ Tai galioja `fs` saugyklai. `s3` laikino objekto neturi (`put` yra vienas
`PutObject`), tad ten klausimas neegzistuoja — bet šlavėjas privalo tai spręsti pagal
eilutės `storage_type`, ne prielaida, ta pačia taisykle kaip visi kiti per-row
sprendimai šiame skyriuje.

⚠️ **ĮĖJIMO SĄLYGA 4a: ŠLAVĖJAS NEGALI LIESTI VYKSTANČIO RAŠYMO.**

Determinizmas pridėtas dėl ATRANDAMUMO, bet jis kartu padarė objektą PAŽEIDŽIAMĄ. Kol
vardas buvo atsitiktinis, galiojo netyčinė savybė: šlavėjas laikino failo ištrinti
NEGALĖJO — vardo nebuvo iš kur sužinoti. Dabar gali.

Scenarijus: registro eilutė sukuriama PRIEŠ `put()`, o didelis rezultatas rašomas ilgai.
Jei eilutė atrodo pakankamai sena — atkurta iš dump'o su senu `created_at`, laikrodžio
šuolis arba agresyviai sukonfigūruotas horizontas — šlavėjas apskaičiuoja tą patį vardą
ir jį pašalina. Rašytojas gauna `ENOENT` ties `rename`, arba `rename` pavyksta, o
objektas jau ne tas.

⚠️ **24 h horizontas tai dengia ATSITIKTINAI, ne pagal konstrukciją.**
`revivalHorizonsMs()` atsako „kada eilė gali prikelti darbą", ne „kiek gali trukti vienas
rašymas". Tai dvi skirtingos trukmės, sutampančios tik dabar; pakeitus vieną, kita tyliai
nustotų dengti.

**Sprendimas, kurį šlavėjas privalo įgyvendinti:**

1. `abandoned` eilutės šluojamos laisvai — rašytojas jau baigė, ir tai žinoma iš būsenos;
2. `pending` eilutėms horizontas turi ATSKIRĄ, eksplicitiškai išvestą narį: „maksimali
   vieno rašymo trukmė". Jis NEIŠVEDAMAS iš `revivalHorizonsMs()` ir negali būti su juo
   sulietas — kitaip grįžtame prie sutapimo;
3. `created_at` po atkūrimo iš dump'o yra ŠALTINIO laikas, tad amžius iš jo gali būti
   melagingai didelis. Šlavėjas privalo tai spręsti fail-closed — ta pati riba kaip
   `deploymentIdentity` („duomenys keliauja su `pg_dump`"), ir ji sprendžiama šlavėjo
   žingsnyje su testu, ne prielaida.

   ⚠️ **Dengiama tik DETEKTUOJAMA dalis, ir tai lieka `UNVERIFIED`:** ateityje esantis
   `created_at` atpažįstamas, o įtartinai senas, bet praeityje esantis — ne, nes nuo
   tikrai senos eilutės jis neatskiriamas.

   ⚠️ **Bet tai neišnaudota kryptis, ne principinis apribojimas.** Jei atkūrimas paliktų
   žymą apie ATKŪRIMO MOMENTĄ (`backup_horizon` jau yra tos pačios šeimos artefaktas),
   eilutės, kurių `created_at` ankstesnis už paskutinį atkūrimą, būtų traktuojamos
   atskirai — tai neatskirtų „sena" nuo „iš dump'o", bet atskirtų „iki atkūrimo" nuo „po
   jo". Ataskaitos `UNVERIFIED` eilutė privalo nurodyti šią kryptį, kitaip po metų ji
   skaitysis kaip riba, kurios nėra kaip peržengti.

⚠️ Priežastis užrašoma, ne tik sprendimas: **determinizmas buvo pridėtas dėl
atrandamumo, ir jis kartu padarė objektą pažeidžiamą.** Be šito sakinio kitas žmogus,
matydamas „papildomą narį horizonte", pagrįstai laikys jį pertekliumi.

⚠️ **SĄLYGA 4b: FAIL-CLOSED TURI SAVO PABAIGĄ — ARBA BENT MATOMUMĄ.**

Iš 4a seka, kad egzistuos `pending` eilutės, kurių šlavėjas neliečia NIEKADA:

| Eilutė | Ar kenkia? |
|---|---|
| iš atkurto dump'o su melagingai senu `created_at` | **Taip** — objektas gali būti, o šlavėjas jo neliečia PAGAL APIBRĖŽIMĄ, ne dėl klaidos |
| likusi po proceso, žuvusio PRIEŠ `put()` | Ne — objekto nėra, eilutė yra tik šiukšlė registre |

Tai ta pati forma, kurią 7.5a jau sutiko ištrynimo žymoms: **neišspręstos žymos
nesensta**. Sprendimas ten buvo ne horizontas, o MATOMUMAS, ir precedentas yra
`retentionSweeper.js:269-274`:

> FAIL-SAFE nėra klaida - tai sąmoningas atsisakymas spėlioti. Bet jis privalo būti
> matomas: tyliai praleistas valymas atrodytų kaip valymas.

Šlavėjas privalo turėti tos pačios formos analogą: **skaitiklį „`pending` eilučių,
praleistų dėl fail-closed", ir `log.warn`, kai jis nenulinis.** Be jo fail-closed yra
teisingas sprendimas su neapibrėžta pabaiga — o saugyklos augimą kas nors aiškinsis po
metų. Skaitiklis eina į tą pačią `runRetentionSweep()` suvestinę kaip `jobs`, `audio`,
`auditEntries`, `tombstones`.

⚠️ **SĄLYGA 4c: „MAKSIMALI RAŠYMO TRUKMĖ" YRA EURISTIKA, IR TAI UŽRAŠOMA IŠ KARTO.**

4a sąmoningai atsieja šį narį nuo `revivalHorizonsMs()`, bet iš to seka kaina: atsiranda
NAUJA RANKINĖ konstanta. Skirtumas nuo prikėlimo horizontų yra esminis — pastarieji
IŠVEDAMI iš eilės konfigūracijos, tad pasikeitus eilei riba pasikeičia savaime. Rašymo
trukmė tokio šaltinio neturi.

Dalinį šaltinį ji vis dėlto turi, ir jis įvardijamas: **`MAX_RESULT_BYTES`**
(`utils/resultLimits.js:154`, numatyta 20 MiB) kartu su saugyklos užklausos timeout'u
apibrėžia viršutinę vieno rašymo trukmės ribą geriau nei pasirinktas skaičius. `fs`
timeout'o neturi; `s3` naudoja SDK numatytuosius, tad tikslaus šaltinio šiandien NĖRA —
ir būtent todėl konstanta yra euristika, ne išvedimas.

Todėl ji užrašoma tuo pačiu šablonu kaip `MAX_SEGMENTO_BAITAI` (#294): **iš ko kilo, ką
atmeta ir KADA NUSTOTŲ GALIOTI.** Be to po pusmečio ji bus arba „supaprastinta", arba
padvigubinta be matavimo — abu be jokio signalo, nes rankinė reikšmė tyliai atsilieka nuo
tikrovės (ši klasė projekte kartojosi keturis kartus).

⚠️ **KODĖL IŠVEDIMO NĖRA: RIBOS NIEKAS NEAPIBRĖŽIA.**

Tikslinimas, kuris keičia paieškos kryptį ateities skaitytojui. Viršutinės vieno rašymo
trukmės ribos nėra ne todėl, kad jos neapskaičiavome, o todėl, kad **jos niekas
neapibrėžia**: `fs` `put()` timeout'o neturi apskritai, o `s3` naudoja AWS SDK
numatytuosius, kurių repo nefiksuoja. `API_TIMEOUT_MS` yra `httpClient` konstanta ir
saugyklų neliečia.

Vadinasi 4c yra euristika ne dėl formulės trūkumo, o dėl **trūkstamo apribojimo**. Kas
nors, norintis 4c paversti išvedimu, turi pirma pridėti tą apribojimą (saugyklos
užklausos timeout'ą), o ne ieškoti geresnės formulės iš esamų reikšmių.

**Failai**
- `backend/utils/jobErasure.js` — external objekto šalinimas per `ArtifactStore`
- `backend/services/lifecycleService.js` — `STORED_IN_JOB_RECORD` šaka (`:129`, `:434`)
- `backend/utils/artefactScanner.js` — `transcript`/`protocol` skenavimas
- `backend/utils/artefactInventory.js` — aprašai
- `backend/utils/backupPolicy.js` — `TABLE_BY_TYPE` per-row (paruošimas PR-7)
- `docs/artefact-lifecycle.md` — registro lentelė, §„Praleidžiami" ir naujas
  skyrius **„Ko šis etapas NEAPIMA"** su `list(prefix)` riba
- `docs/deletion-guarantees.md` — external objekto vieta ištrynimo garantijose

**Sprendimas dėl `lifecycleService`:** `STORED_IN_JOB_RECORD` nebelieka statinis
sąrašas. `transcript`/`protocol` gauna tokį pat predikatą kaip `source_audio`
po PR #288: **„ar artefakto nebėra"** — `jobRemoved && (artifactRemoved || artifactAbsent)`.
Tai ne nauja konstrukcija, o ta pati, kurią #288 jau įvedė gretimai eilutei.

⚠️ **PER-ROW `storage_type`, NE PER-CONFIG — IR TAI GALIOJA VISIEMS TRIMS
VARTOTOJAMS** (A4, body „Ribos"). Po migracijos DB bus **mišri** ilgą laiką:
dalis eilučių `inline`, dalis external. Todėl nei `lifecycleService`, nei
`artefactScanner`, nei `backupPolicy` negali klausti „koks aktyvus backend'as" —
kiekvienas sprendžia pagal **tos eilutės** `storage_type`. Konfigūracija sako, kur
bus rašoma toliau; ji nesako, kur guli jau egzistuojantis rezultatas.

Praktinė pasekmė: `inline` eilutei predikatas lieka `jobRemoved` (šiandieninis
teisingas elgesys), external eilutei — reikalauja objekto pašalinimo. Tas pats
sprendimo šaltinis naudojamas skenavime ir backup politikoje.

⚠️ **BET ŠIANDIEN NĖ VIENAS IŠ TRIJŲ NETURI IŠ KUR TO SUŽINOTI** (Codex, #289).

`SELECT_JOB` traukia tik `r.payload`, `rowToJob()` rezultato `storage_type`,
`storage_key`, `bytes` ar `checksum` neatskleidžia, o `job.storageKey` yra
**source_audio** raktas, ne rezultato. Vadinasi „sprendžia pagal eilutės
`storage_type`" be atskiro kelio yra neįvykdomas nurodymas — ir vartotojai
grįžtų prie eksplicitiškai atmestos aktyvios konfigūracijos.

Todėl PR-3 metaduomenų `SELECT` praplečiamas rezultato **reference** laukais
(`storage_type`, `storage_key`, `bytes`, `checksum`) — **be `payload`**, tad
hidratacijos riba nepažeidžiama: tai metaduomenys, ne turinys.

⚠️ **PATAISYTA: NUORODA LIEKA VIDINĖ, O VARTOTOJAI GAUNA STORE LYGMENS METODĄ.**

Ankstesnė šio skyriaus redakcija siūlė `rowToJob()` pateikti juos atskiru job'o lauku
(`job.resultStorage`). Tai buvo klaidinga DVIEM atžvilgiais, ir abu verti užrašymo,
nes eilutė jau kartą suklaidino:

1. **Ji laužtų formos paritetą.** `memory` ir `redis` tokių laukų neturi ir negali
   turėti, o `jobStoreBackendContract` nuo PR-3 lygina grąžinamų laukų AIBĘ. Naujas
   laukas iškart duotų trečią divergenciją tame pačiame teste, kuris tam ir atsirado.
2. **Ir PR-5 užduočiai jos neužtektų.** Erasure privalo trinti PAGAL REGISTRĄ — visus
   job'o bandymus, ne tik laimėjusį. `job.resultStorage` pateiktų VIENĄ nuorodą, būtent
   tą, kuri jau saugi, nes referencuota. Pralaimėjusių bandymų objektai, dėl kurių
   registras ir egzistuoja, į job modelį nepatektų iš principo.

**Teisinga forma:** store lygmens metodas, grąžinantis VISAS job'o rezultato artefaktų
nuorodas — laimėjusią (`job_results`) plius registro bandymus (`job_result_attempts`).
Ne job objekte, o greta jo.

Precedentas jau yra: `listReferencedStorageKeys()` daro tiksliai tą patį audio pusėje ir
yra backend kontrakto dalis. PR-5 reikia jo analogo rezultatams — tos pačios šeimos
metodas, tas pats **fail-safe** elgesys (`null`, kai surašyti nepavyksta, kad kvietėjas
NETRINTŲ vietoj „nieko nenaudojama"), ir tas pats **elgesiu grįstas** kontrakto testas,
kurio reikalauja #157 body.

`memory` ir `redis` jį įgyvendina trivialiai (bandymų registro jie neturi, tad grąžina
tai, ką turi), ir paritetas išlieka METODŲ AIBĖS lygmenyje, ne job formos.

Visi trys vartotojai eina per TĄ PATĮ kelią; nė vienas neskaito `job_results`
savo užklausa — kitaip atsirastų trečia rezultato vietos interpretacija.

| Vartotojas | Ką klausia | Ko NEDARO |
|---|---|---|
| `lifecycleService` | ar external objektas pašalintas | neklausia konfigūracijos |
| `artefactScanner` | ar `storage_key` rodo į esantį objektą (`head`) | neskaito turinio |
| `backupPolicy` | ar turinys yra `job_results`, ar saugykloje | nesprendžia pagal aktyvų backend'ą |

⚠️ Iš to seka PR-3 apimties pokytis: metaduomenų `SELECT` nebėra vien „be
`payload`" — jis turi ir KĄ pateikti. Failų sąraše tai `postgresStore.js` ir
`rowToJob()`, o PR-5 tik naudoja jau esantį kelią.

**Registras lieka statinis** (A4): `artefactInventory` aprašai nebedeklaruoja
fizinės vietos apskritai — jie aprašo artefakto **tipą**. Vietą sprendžia
vartotojai. Alternatyva (registras su funkcija `saugojimoVieta(env)`) atmesta:
ji padarytų registrą priklausomą nuo konfigūracijos, o mišrioje DB konfigūracija
ir taip nėra tiesos šaltinis.

**DoD**
- „Autoritetingas erasure kelias pašalina external object; dalinis object-storage gedimas negali būti raportuojamas kaip sėkmingas galutinis ištrynimas."

⚠️ **KADA `delete()` KVIEČIAMAS, O KADA NE — ATSAKYTA KONTRAKTE, NE PR-5.**

Erasure eina per `job_results.storage_key`: yra nuoroda — yra ką trinti
saugykloje. `inline` eilutėje ji `NULL`, tad atskiro kvietimo NĖRA: turinys
gyvena toje pačioje eilutėje ir dingsta kartu su ja (`ON DELETE CASCADE`).
Adreso niekas neatkurs, nes jo niekas nepersistino — ir nereikia.

Vadinasi PR-5 predikatas yra: `reference !== null` → objektas privalo būti
pašalintas ir tai patvirtinta; `reference === null` → eilutės ištrynimas IR YRA
ištrynimas. Be šio sakinio PR-5 turėtų išsiaiškinti tai pats, o ten klaidos kaina
yra ištrynimo garantija.
- „`services/lifecycleService.js` `STORED_IN_JOB_RECORD` šaka pakeista…"
- „Mutation įrodymas: `ArtifactStore.delete()` meta klaidą → `criticalFailure: true` → DB metaduomenys NEPAŠALINAMI…"
- „`utils/artefactScanner.js` `transcript` / `protocol` įrašai nebeturi `reason: "saugoma job_record viduje"`; skenavimo elgesys sprendžiamas **pagal faktinį eilutės `storage_type`**, ne pagal konfigūraciją."
- „Orphan aptikimas apibrėžtas **DB kryptimi**: kiekvienam persistintam `storage_key` tikrinamas objekto egzistavimas (`head`), ir „DB rodo, objekto nėra" failina uždarai."
- „Priešinga kryptis („objektas yra, DB nerodo") NĖRA šio issue apimtis: ji reikalautų `list(prefix)` visuose trijuose backend'uose. Riba užrašoma `docs/artefact-lifecycle.md` skyriuje „Ko šis etapas NEAPIMA" ir atskiru follow-up issue; DoD negali teigti platesnio aptikimo, nei pristatoma (AGENTS.md §12.1)."
- „`utils/artefactInventory.js` `TRANSCRIPT` / `PROTOCOL` aprašuose **nebelieka fizinės saugojimo vietos teiginio** — registras aprašo artefakto tipą, ne saugyklą. Fizinę vietą sprendžia vartotojai pagal eilutės `storage_type`."

**Follow-up issue** sukuriamas ŠIAME PR (ne vėliau): „object → DB reference
inventorizacija per `list(prefix)`". Riba, kuri gyvena tik dokumente ir neturi
adreso, po pusmečio virsta numanoma garantija.

**§9.1**
| Sargas | Mutacija | Krenta? |
|---|---|---|
| `delete()` klaida → `criticalFailure` | pašalinam šaką | taip — job'as pašalinamas, nors objektas liko |
| per-row `storage_type` sprendimas | grąžinam statinį `STORED_IN_JOB_RECORD` | taip — external eilutė raportuojama `deleted` be objekto šalinimo |
| DB krypties orphan patikra | pašalinam `head()` | taip — trūkstamas objektas nebeaptinkamas |

Kontrolės: sėkmingas `delete()` → job'as pašalinamas (kitaip patikra virstų
visada-„kritinė nesėkmė"); **`inline` eilutė ir toliau raportuojama pagal
`jobRemoved`** (kitaip PR-5 sulaužytų šiandien teisingą elgesį).

---

### PR-6 — `inline` → external migracija

**Ką palieka veikiantį:** CLI migracija veikia, restartable; galiojanti
`job_results` būsena niekada nepažeidžia invarianto.

---

⚠️ **ĮĖJIMO SĄLYGOS — SURINKTA PR-6 PRADŽIOJE** (tas pats šablonas kaip PR-4 ir PR-5).

| # | Sąlyga | Kur priimta |
|---|---|---|
| 1 | Progresas — **atskira lentelė** `artifact_migration_progress`, ne `job_results` laukai | body: „progresas nesaugomas kaip negaliojanti `job_results` būsena" |
| 2 | Tvarka: **object write → integrity verification → atominis reference switch** | body DoD |
| 3 | **Restartable ir idempotentiška**; gedimas nė viename taške nepraranda vienintelės kopijos | body DoD |
| 4 | Dry-run ir tikra migracija — abi padengtos testais | body DoD |
| 5 | ~~**Stebėtojas antroje jungtyje** įrodo, kad commit'intos pažeidžiančios `job_results` būsenos nepastebėta~~ → **PAKEISTA:** stebėtojas antroje jungtyje įrodo, kad nepastebėta commit'intos pažeistos POROS — objektas ↔ nuoroda ir progresas ↔ nuoroda | §9.1 (perrašyta po matavimo, CI 34323230438) |
| 6 | ⚠️ **Migracijos rašymas eina per bandymų REGISTRĄ** — objektas, parašytas migracijos ir neįsipareigotas, yra tos pačios klasės orphan'as kaip completion kelyje | PR-4/PR-5 pasekmė, žr. žemiau |
| 7 | Migracija **nešalina** inline `payload`, kol objekto vientisumas nepatvirtintas — tai ta pati „vienintelė kopija" taisyklė | body DoD |

✅ **KĄ PR-1…PR-5 JAU PADARĖ (patikrinta kode):**

- `job_results_storage_shape` (migracija `1756200000000`) jau reikalauja PILNO trejeto:
  external eilutė privalo turėti `storage_key`, `bytes`, `checksum` ir `payload IS NULL`;
- `upsertResult()` reference switch yra VIENAS `INSERT ... ON CONFLICT DO UPDATE` sakinys;
- bandymų registras, jo šlavėjas ir erasure per registrą veikia (PR-4, PR-5);
- `ArtifactStore` riba, `paruostiReiksme()` ir kanoninė tapatybė — PR-2.

✅ **ATSAKYTA MATAVIMU — §9.1 MUTACIJA NEĮVYKDOMA** (CI 34323230438, `backend` job'as,
tikras `postgres:16-alpine`, `REQUIRE_POSTGRES=1`; testas `jobResultsShapeDomain.integration`,
12/12, nė vieno praleisto).

Planas numatė mutaciją „du `UPDATE` atskirose transakcijose → stebėtojas pagauna
commit'intą tarpinę būseną → krenta". Ji NEĮVYKDOMA: po `1756200000000` nė vienas
dalinis sakinys DB nepraeina.

Matuota ne pavyzdžiais, o visa skaidymo erdve. Reference switch yra penki priskyrimai
(`storage_type`, `storage_key`, `payload`, `bytes`, `checksum`); ištirti VISI netušti
tikri poaibiai — 2⁵−2 = 30 kiekviena kryptimi, `inline` → external ir atgal. Visi 60
atmesti su `23514` ties `job_results_storage_shape`. Tai padengia ir ilgesnius
skaidymus: bet kurio N sakinių skaidymo PIRMASIS sakinys yra tikras poaibis, tad
commit'intos tarpinės būsenos neturi joks skaidymas.

Kontrolės, be kurių išvada būtų neteisinga dėl teisingo rezultato: pilnas perėjimas
vienu sakiniu PRAEINA abiem kryptimis (kitaip „joks `UPDATE` neveikia" atrodytų kaip
įrodytas atomiškumas), suvaržymas nėra `DEFERRABLE` (`pg_constraint.condeferrable =
false`), ir dalinis `UPDATE` po eksplicitinio `SET CONSTRAINTS ALL DEFERRED` vis tiek
meta iš karto — bendra transakcija irgi nėra išeitis.

**Iš to seka dvi pasekmės, ir abi galioja:**

1. Tikrasis invarianto sargas yra **CHECK constraint**, ne migracijos kodo tvarka.
   Atomiškumo nereikia SAUGOTI — jis yra schemos savybė. §9.1 stebėtojas antroje
   jungtyje įrodo MAŽIAU, nei planas žadėjo: pažeidžiančios būsenos jis nepamatytų
   ir tada, jei migracija būtų parašyta blogai, nes ją atmestų DB.
2. Todėl stebėtojas persiorientuoja į **poras**, kurių CHECK NEGINA:
   objektas ↔ nuoroda ir progresas ↔ nuoroda. Tai vieninteliai langai, kuriuos
   migracija dar gali palikti atvirus — `job_results` eilutės viduje jų nebėra.

⚠️ **KODĖL MATAVIMAS LIKO TESTU, NE ATASKAITOS EILUTE.** Vienkartinis matavimas
laikinoje šakoje atsako į šiandienos klausimą ir nieko negina rytoj — taip PR-4
mutacijos vos nedingo kartu su ištrinta šaka. `jobResultsShapeDomain.integration` yra
tos pačios šeimos testas kaip `jobResultsJsonbDomain.integration`: susilpninus
`job_results_storage_shape`, jis pasakys tai iškart, ir abi pasekmės aukščiau bus
peržiūrėtos, o ne tyliai pasens.

⚠️ **SĄLYGA 6 UŽRAŠOMA ATSKIRAI, NES PLANE JOS NEBUVO.**

Planas PR-6 rašė prieš PR-4 orphan sprendimą. Migracija rašo objektą į saugyklą ir tik
paskui perjungia nuorodą — tai TIKSLIAI ta pati seka, dėl kurios PR-4 įvedė bandymų
registrą: procesas, kritęs tarp `put()` ir reference switch, palieka objektą su
transkripcija, kurio nerodo nė viena `job_results` eilutė. Be registro migracija būtų
naujas orphan'ų šaltinis — ta pati klasė, kurią PR-5 ką tik uždarė.

---

**Failai**
- `backend/scripts/migrate-artifacts.mjs` (naujas, plonas — logika `utils/`)
- `backend/utils/artifactMigration.js`
- `backend/tests/artifactMigration.integration.test.js`

**Progreso saugojimas:** atskira lentelė `artifact_migration_progress`
(`job_id`, `state`, `object_key`, `updated_at`), **ne** `job_results` laukai.
Body reikalauja: „migracijos progresas nesaugomas kaip negaliojanti `job_results` būsena".

**DoD**
- „Inline → external migracija yra restartable ir idempotentinė: object write → integrity verification → atominis DB reference switch; gedimas nė viename taške nepraranda vienintelės rezultato kopijos."
- „Migracijos testas elgesiu įrodo, kad nėra stebimos DB būsenos, pažeidžiančios `job_results_storage_shape`…"
- „Dry-run ir real migration testai; pakartotinis paleidimas saugus."

**§9.1 — „jokia stebima būsena nepažeidžia invarianto" yra sunkiausias punktas.**
Statinė „vienas UPDATE" patikra netinka (§9.2, body tai sako tiesiogiai).

~~Sprendimas: migracija leidžiama su **stebėtoju antroje jungtyje**, kuris cikle
(`READ COMMITTED`) skaito `job_results` ir kiekvieną matytą eilutę tikrina prieš
invariantą. Pažeidimas → testas krenta.~~

⚠️ **PERRAŠYTA (§12.1). SENAS RECEPTAS BUVO NEĮGYVENDINAMAS, IR PRIEŽASTIS
SVARBESNĖ UŽ PATĮ RECEPTĄ.**

Toks stebėtojas **negalėtų kristi**. Išmatuota (`jobResultsShapeDomain.integration`,
CI 34323230438): visi 2⁵−2 = 30 netušti tikri priskyrimų poaibiai kiekviena
kryptimi atmetami `23514` ties `job_results_storage_shape`. Commit'intos
pažeidžiančios `job_results` eilutės padaryti NEĮMANOMA — nei dviem sakiniais,
nei daugiau (bet kurio skaidymo pirmasis sakinys yra tikras poaibis), nei bendra
transakcija (suvaržymas nėra `DEFERRABLE`, sakinys krenta iš karto).

Vadinasi senas stebėtojas tikrintų tą patį `CHECK`, kurį DB taiko kiekvienam
sakiniui. **Jis įrodo ne „mažiau, nei tikėtasi" — jis įrodo nieko**, o testas,
kuris negali kristi, nėra įrodymas.

**NAUJAS RECEPTAS: stebimos POROS TARP SISTEMŲ**, kurioms joks `CHECK`
negalioja pagal apibrėžimą, nes jos yra tarp dviejų lentelių arba tarp DB ir
saugyklos:

| Pora | Pažeidimas | Kaip mutuojama |
|---|---|---|
| objektas ↔ nuoroda | external eilutė rodo į raktą, kurio saugykloje nėra | eilutė perjungiama į nesantį objektą |
| progresas ↔ nuoroda | `artifact_migration_progress` sako `done`, o eilutė tebėra `inline` | progresas įrašomas atskira, ANKSTESNE transakcija |

Abi mutacijos VYKDOMOS (`artifactMigration.integration`), ne teigiamos: stebėtojas,
kuris nieko nerado, neatskiriamas nuo stebėtojo, kuris neveikia.

⚠️ **KĄ TAI KEIČIA MIGRACIJOJE.** Iš šito seka reikalavimas kodui, ne tik testui:
progreso įrašas privalo būti TOJE PAČIOJE transakcijoje kaip reference switch.
Atskirai rašomas progresas sukurtų būtent tą commit'intą porą, kurios stebėtojas
ieško — ir tai vienintelė vieta, kur migracija dar gali palikti langą.

⚠️ **MUTACIJA PRIVALO SKALDYTI TRANSAKCIJĄ, NE TIK SAKINĮ** (Codex, #289).
Ankstesnė formuluotė žadėjo, kad `UPDATE storage_key` + `UPDATE payload = NULL`
du žingsniais bus pagauta — bet jei abu vyksta TOJE PAČIOJE transakcijoje,
antroji jungtis `READ COMMITTED` režimu tarpinės būsenos nemato IŠ VISO: iki
commit'o ji regi seną eilutę, po jo — galutinę. Tokia mutacija stebėtojo
nesulaužytų, ir testas būtų atrodęs stipresnis, nei yra.

~~Teisinga mutacija: du `UPDATE` **atskirose transakcijose** (arba `COMMIT` tarp
jų) → stebėtojas pagauna commit'intą tarpinę būseną → **krenta**.~~

⚠️ **ATŠAUKTA (§12.1).** Ši mutacija neįvykdoma — matavimas ir naujas receptas
užrašyti aukščiau, prie perrašyto §9.1 sprendimo. Sakinys paliekamas perbrauktas,
o ne ištrintas, nes jis paaiškina, KODĖL ankstesnis Codex raundas (#289) reikalavo
skaldyti transakciją: tuo metu prielaida, kad skaidymas apskritai įmanomas, dar
nebuvo patikrinta.

---

### PR-7 — Backup/restore, dokumentai, sargo pašalinimas

**Ką palieka veikiantį:** visą grandinę; tik čia dingsta fail-closed sargas.

---

⚠️ **ĮĖJIMO SĄLYGOS — SURINKTA PR-7 PRADŽIOJE** (tas pats šablonas kaip PR-4/5/6).

⚠️ **SURINKTA IŠ PLANO IR KODO, NE IŠ ATMINTIES.** Metodas nėra formalumas: iš
septynių pradžioje numanytų sąlygų **trys** pasirodė kitokios, o **dvi** jau
įgyvendintos. Prielaida, paimta iš ankstesnio pokalbio, yra tas pats silpnas
įrodymas, kurį §14.1 draudžia — tik jos šaltinis atrodo patikimesnis.

| # | Sąlyga | Kur priimta | Būsena kode | Priklauso nuo | Kas ir kada pamatys, kad suveikė |
|---|---|---|---|---|---|
| 1 | **Aktyvavimo barjeras** — atidaromas TIK uždarius prielaidas; **NE PR-7, o atskiras #155 apimties PR** | ADR `155-postgres-authority.md` §„AKTYVAVIMO BARJERAS"; plano DoD | `backendSelection.js:55` = `false` | 9, 10 | ADR prielaidų lentelė; `selectBackend()` grąžina `barjeras: true` |
| 2 | **Sargo pašalinimas — paskutinis commit'as** (impl → integrity → regresija → dokumentai → sargas) | body §8; ši sekcija | sargas gyvas (`postgresStore.js:1623-1627`) | **1** | `git log` peržiūroje — plane įvardyta kaip grąžinimo pagrindas |
| 3 | **`rasymoSaugykla` prijungimas** tik po PR-5 skaitymo pusės | ši sekcija; PR-5 = #304 | neprijungta (`:823`, `:840`); **stebėtojas yra** (`artifactStore/prijungimoBusena.js`) | **1** | `doctor` ir `/api/health/deep` varnelė „Artefaktų saugyklų prijungimas (startas)": lygina PARINKTA (`ARTIFACT_STORE_BACKEND`) ↔ PRIJUNGTA (rezolveris) ↔ REIKALINGA (`job_results` + `job_result_attempts` tipai) |
| 4 | **Resolveris pagal `result_storage_type`**, ne globalus store | plano PR-4; matrica | **jau padaryta** (`:1190`, `:1926`) | — | `jobStoreHydration.integration` |
| 5 | **`neatkartojama` grandinė: nulis BullMQ pakartojimų** | plano §„PR-4 DoD punktas"; DoD `PARTIAL / UNVERIFIED` | **#298 atviras** | **1**, #298 | Testas privalo matuoti PAKARTOJIMŲ SKAIČIŲ, ne lauko buvimą |
| 6 | **`backupPolicy.TABLE_BY_TYPE` per-row** | `utils/backupPolicy.js:94` — riba užrašyta, atsakymas atidėtas PR-7 | statinis žemėlapis | — | Kopijos ataskaita teigtų turinį, kurio `job_results` nebėra |
| 7 | **Restore ataskaita skirsto pagal `nepriklausomas`, ne `ok`** | body §32, §35; ši sekcija | nėra | — | ⚠️ Inline `ok: true` tikras, bet tuščias — mišrioje DB rodytų ~100 % |
| 8 | **Laukiama vientisumo reikšmė — iš DB, niekada neperskaičiuota iš tikrinamo objekto** | ši sekcija, „Restore verifikacija" | nėra | — | Mutacija: `head()` vietoj `verify()` → sugadintas objektas praeitų |
| 9 | ⚠️ **Eilės prieinamumo PREFLIGHT** — **ATSKIRAS PR, PRIEŠ PR-7** | ADR barjero prielaidų lentelė | ✅ **ĮGYVENDINTA** (#322): `patikrintiEilesJungti()` (`queues/config.js:235`), reikalaujama `jobRunner.init()` | — | Realus probe PRIEŠ pradedant klausytis; verdiktas `doctor` ir `/api/health/deep` per `runSelfChecks()`, ne logo eilutėje |

⚠️ **SĄLYGA 9 BUVO PRALEISTA PIRMOJE REDAKCIJOJE.** Ji gyvena ADR'e, ne plano
PR-7 sekcijoje, tad sąrašas, surinktas tik iš plano, jos nepagautų. ADR aprašo
defektą tiksliai: `hasQueueBackend()` vertina TIK konfigūraciją, `jobRunner.init()`
tikrina tik ar `bullmq` galima `require` (`queues/jobRunner.js:77-82`), o jungtis
kuriama LAZY pirmo `add` metu (`queues/transcriptionQueue.js:13-21`). Su
PostgreSQL metaduomenimis prie Redis **nesijungia niekas**: `server.js` pažymėtų
runner'į ready ir imtų klausytis, o pirmas `enqueue` kabotų arba kristų.

⚠️ **KAI SĄLYGA 1 TAPS SPRENDIMU, JIS PRIVALO APIMTI IR ATSUKIMĄ.**

Atidarymas yra VIENKRYPTIS, tad pateikimas be atsakymo „ką darome, jei po
savaitės paaiškės problema" būtų nepilnas. Mechanika užrašyta ADR
`155-postgres-authority.md` §„Grįžimas atgal" → „Kas nutinka mechaniškai".

Trumpai, kad sprendimo pateikėjas neieškotų: perjungimas atgal įvyksta TYLIAI
(nėra nei patikros, nei įspėjimo), job'ai tampa nematomi iš karto, o **po #157
saugykloje lieka transkripcijų, kurių adresas gyveno tik PostgreSQL'e** — jų
nepasiekia nei erasure, nei retencija, ir jų neįmanoma surasti rankiniu būdu
(`list(prefix)` pagal A3 nėra). Tai duomenų apsaugos, ne prieinamumo klausimas.

Teisinga seka atsisakant PostgreSQL: pirma IŠTRINTI duomenis per veikiantį
diegimą, tik paskui keisti konfigūraciją.

⚠️ **SĄLYGA 1 ŠIANDIEN NĖRA §18.3 SPRENDIMAS — JI UŽBLOKUOTA NEPILNA PRIELAIDA.**

ADR išvardija šešias prielaidas; dvi neuždarytos: **eilės preflight** (sąlyga 9)
ir **fail-closed startas, patikrintas realiai** (sąlyga 10 žemiau). Kol jos
atviros, „ar atidaryti barjerą" nėra klausimas — atsakymas žinomas ir yra „ne".
Sprendimu jis tampa tik jas uždarius.

| # | Sąlyga | Kur priimta | Būsena | Kas pamatys |
|---|---|---|---|---|
| 10 | **Fail-closed startas patikrintas REALIAI** — **kartu su atidarymu, atskirame #155 PR** | ADR barjero lentelė | įrodyta tik unit lygmeniu (`_initializePostgresForTests`) | CI žingsnis: startas su neprieinama DB ir ATIDARYTU barjeru privalo kristi, ne nusileisti į atmintį |

⚠️ **KODĖL SĄLYGA 10 NEGALI BŪTI ANKSČIAU — TAI NE PLANAVIMO PASIRINKIMAS.**

*(Galioja ir po iškėlimo: ji eina kartu su atidarymu, tik nebe PR-7, o atskirame
#155 apimties PR.)*

Ji reikalauja paleisti kelią, kurio **uždarytas barjeras neleidžia pasiekti**.
`initializePostgres()` produkcijoje nekviečiama, kol `POSTGRES_AKTYVAVIMAS_LEISTAS
= false`; šiandien ji pasiekiama tik per `_initializePostgresForTests`. Vadinasi
„realus fail-closed startas" prieš atidarymą reikštų arba testinį įėjimą (t. y.
vėl NE realų kelią), arba laikiną barjero atidarymą — o tai tas pats atidarymas,
tik be jo peržiūros.

ADR tą patį sako iš kitos pusės: *„Barjerą atidarius pirmas realus startas su
neprieinama DB ir BŪTŲ tas testas."*

⚠️ **IŠ TO SEKA FORMA: CI ŽINGSNIS, NE VIENETINIS TESTAS.** Įrodymas yra
PROCESO elgesys — startas su `DATABASE_URL` į nepasiekiamą adresą privalo baigtis
klaida, o ne tyliu nusileidimu į atmintį. Vienetinis testas tikrintų funkciją;
čia klausimas yra, ką daro `server.js` startas.

⚠️ **RIZIKA, KURIĄ TAI ANKSČIAU KĖLĖ, DABAR PAŠALINTA.** Ankstesnė redakcija
sąlygas 10 ir 1 dėjo į tą patį commit'ą PR-7 viduje, tad peržiūrėtojas būtų matęs
negrįžtamą sprendimą ir šešis kitus darbus viename PR. Iškėlus barjerą į atskirą
PR, tas PR turi VIENĄ temą — aktyvavimą — ir visa jį pagrindžianti medžiaga
(grįžimo mechanika, `deployment_identity` riba, `deletion-guarantees.md` sąlyga)
atsiduria greta to vienintelio jungiklio, kurį ji aprašo.

**TVARKA — BARJERAS IŠKELIAMAS Į ATSKIRĄ PASKUTINĮ PR**

```
0. eilės prieinamumo preflight  — ATSKIRAS PR, sumergintas PRIEŠ (sąlyga 9; #319)
──────────────────────────────  PR-7 (#157 apimtis) ──────────────────────────────
1. rasymoSaugykla prijungimas             (sąlyga 3)
2. `neatkartojama` grandinė               (sąlyga 5, kartu su #298)
3. backup/restore + per-row + ataskaita   (sąlygos 6, 7, 8)
4. integrity testai
5. pilna regresija (postgres + s3 + **postgres-s3** rinkiniai)
6. dokumentai
7. sargo pašalinimas — PASKUTINIS         (sąlyga 2)
──────────────────────────  PR „aktyvavimas" (#155 apimtis) ──────────────────────
8. ── BARJERAS ── + fail-closed starto CI žingsnis  (sąlygos 1 ir 10; §18.3 TIK ČIA)
   + ADR prielaidų lentelės uždarymas
   + `deletion-guarantees.md` sąlyga ir grįžimo mechanika (#326)
```

⚠️ **PERRAŠYTA (§12.1). ANKSTESNĖ REDAKCIJA DĖJO BARJERĄ Į PR-7 VIDŲ.**

Sprendimas pakeistas po peržiūros, ir priežastys užrašomos, nes jos stipresnės už
patį pakeitimą:

1. **PR-7 gali įrodyti VISKĄ be atidarymo.** `_initializePostgresForTests`
   egzistuoja, o integraciniai testai `postgresStore` pasiekia tiesiogiai. Tad
   `neatkartojama` grandinė, backup/restore, integrity ir pilna regresija
   uždaromos TESTŲ lygmeniu. Barjero reikia tik sąlygai 10 ir realiam
   produkciniam naudojimui — dviem dalykams, kurie abu yra apie AKTYVAVIMĄ, ne
   apie artefaktus.
2. **Atidarymas — vienintelis NEGRĮŽTAMAS žingsnis visoje sekoje.** Po jo
   atsiranda duomenų, kurių adresas gyvena tik PostgreSQL'e (ADR §„Kas nutinka
   mechaniškai"). Sujungus jį su šešiais kitais darbais, recenzentas vertintų
   negrįžtamą sprendimą ir jį pagrindžiantį darbą VIENAME diff'e. Tai tas pats
   argumentas, kuriuo iš PR-7 buvo iškelta sąlyga 9.
3. **ADR ir planas trijose vietose sako, kad #157 barjero NEATIDARO.** Pakeitus
   tai PR viduje, kurio pavadinimas apie kitką, sprendimas dingtų iš vietos,
   kurioje jo ieškotų.

⚠️ **IŠ TO SEKA, KAD TRYS MINĖTOS VIETOS LIEKA TEISINGOS, IR JŲ TAISYTI NEREIKIA.**
#157 (PR-1…PR-7) barjero neatidaro; jį atidaro ATSKIRAS #155 apimties PR. Tai
užrašoma eksplicitiškai, kad kitas raundas jų „nepataisytų" kaip pasenusių.

⚠️ **SARGO PAŠALINIMAS LIEKA PR-7, NORS BARJERAS — NE.** Jis nuo barjero
nepriklauso: pašalinus sargą, external kelias tampa pasiekiamas TESTUOSE, o
produkcijoje — vis dar ne, nes `rasymoSaugykla` prijungimas be atidaryto barjero
neveikia. Tai nuosekli tarpinė būsena, ne spraga.

⚠️ **KODĖL BARJERAS NEBĖRA PIRMAS PR-7 ŽINGSNIS.** Ankstesnė redakcija jį dėjo
priekyje su argumentu, kad sargo pašalinimas ir prijungimas be atidarymo veiktų
nuo kelio, kurio niekas nepasiekia. Argumentas teisingas apie PRODUKCIJĄ, bet
neteisingas apie ĮRODYMĄ: testai tą kelią pasiekia be barjero, tad PR-7 savo DoD
uždaro ir taip. Taisyklė „sargas paskutinis" galioja toliau — ji kalba apie tvarką
PR-7 VIDUJE.

⚠️ **KUR BUVO PRIEŠTARAVIMAS, IR KUR JO NEBUVO.** Pirmoji šio sąrašo redakcija
(pateikta pokalbyje) sąlygą 10 dėjo 2 žingsniu, o barjerą — 3, nors tas pats
dokumentas sako, kad sąlyga 10 įvykdoma TIK po atidarymo. Tai buvo ne rizika, o
NEGALIMYBĖ. Ji ištaisyta `445bc1c` dar prieš #312 merge — sujungiant abu į vieną
žingsnį. Užrašoma, nes klaida buvo reali, o jos nebuvimas įrašytame plane nėra
įrodymas, kad jos nebuvo.

⚠️ **MATOMUMO STULPELIO IŠVADA.** Iš dešimties sąlygų **viena** (nr. 3) stebėtojo
NETURĖJO. Tai ta pati klasė, kuri šioje sekoje keturis kartus rasta PO fakto, tad
PR-7 privalėjo ją uždaryti testu, ne komentaru.

**Uždaryta pirmuoju PR-7 žingsniu** (`artifactStore/prijungimoBusena.js`): verdiktas
matomas `doctor` ir `/api/health/deep` išvestyje, o netinkama konfigūracija matoma
PRIEŠ pirmą naudojimą, ne per jį. Lentelės 3 eilutės matomumo stulpelis atnaujintas.

⚠️ **IR JI PAKEITĖ DARBŲ EILĘ — PRIEŠ DARBĄ, NE PO JO.**

Natūrali PR-7 pradžia buvo pats prijungimas: sąlyga 3 taip ir suformuluota.
Tuščias matomumo langelis parodė, kad prijungus pirma, jo teisingumą patvirtintų
tik testas, parašytas TAM PAČIAM pokyčiui — t. y. stebėtojas tikrintų pats save.
Todėl 3 sąlyga skyla į du žingsnius, ir stebėtojas eina PIRMAS:

```
0a. prijungimo stebėtojas (šis žingsnis) — verdiktas `doctor`/`health/deep`;
    ŠIANDIEN jis rodo `rasymas_neprijungtas`, ir tai teisingas atsakymas
0b. prijungimas — pirmas jo patikrinimas yra to paties verdikto pavirtimas žaliu
```

Tai pirmas kartas, kai matomumo stulpelis suveikė taip, kaip buvo sumanytas:
ne kaip trūkumo registras, o kaip eiliškumo argumentas. Užrašoma todėl, kad
stulpelio vertė matosi tik iš tokio atvejo — kitaip jis atrodo kaip papildoma
lentelės skiltis.

⚠️ **STEBĖTOJO KAINA — ATIDĖTAS SPRENDIMAS, NE NEPASTEBĖTA DETALĖ.**

`storage_type` neturi indekso nei `job_results`, nei `job_result_attempts`
lentelėje, tad abu `SELECT DISTINCT` yra **seq scan per kiekvieną startą**.
Šiame žingsnyje kaina apribota `SET LOCAL statement_timeout` (2 s) transakcijoje:
nespėta užklausa duoda `nezinoma`, ne lėtą startą ir ne tylų žalią.

Geresnis ilgalaikis sprendimas — **dalinis indeksas**
`(storage_type) WHERE storage_type <> 'inline'`: inline-only bazėje jis TUŠČIAS,
tad nekainuoja nieko, o po migracijos laiko po įrašą external eilutei. Tai tas
pats idiomas kaip `artifact_migration_progress_nesekmes` ir
`job_result_attempts_valytini`.

**Kodėl ne dabar:** tai SCHEMOS pokytis, o šio žingsnio apimtis — stebėtojas.
Indeksas pridedamas IŠMATAVUS realią trukmę (didžiausios žinomos bazės startas),
ne spėjus. Iki tol riba garantuoja, kad blogiausias atvejis yra 2 s ir
`nezinoma`, o ne neribotas laukimas.

---

⚠️ **ĮĖJIMO SĄLYGA: `rasymoSaugykla` PRIJUNGIMAS REIKALAUJA REGISTRO SKAITYMO PUSĖS.**

Produkcinis prijungimas (`initializePostgres()` paduoda saugyklą) negali įvykti anksčiau,
nei veikia erasure pagal registrą IR neįsipareigotų bandymų šlavėjas (PR-5). Priešingu
atveju nutrūkęs procesas paliktų objektą su transkripcija, kurio niekas nepašalins.

Tai PRIKLAUSOMYBĖ, ne PR numeracijos pasekmė: jei šis PR kada nors aplenktų PR-5, sąlyga
lieka galioti, o prijungimas — atidedamas.

**Vidinė commit'ų tvarka — privaloma, ne rekomenduojama**

```
1. backup/restore implementacija (be sargo pašalinimo)
2. integrity testai (missing / corrupt / kontrolė)
3. pilna regresija + integraciniai įrodymai (**postgres, s3 IR postgres-s3** rinkiniai žali)
   ⚠️ `postgres-s3` NEPRALEIDŽIAMAS: PR-7 backup/restore kelias kerta ABU servisus, tad regresija, vardijanti tik `postgres` ir `s3`, praleistų KIEKVIENĄ kombinuotą scenarijų. Nepraleidimą tikrina `verify-postgres-suite-ran.mjs /tmp/pgs3-tap postgresS3`
4. dokumentai (runbook §9a/§9c/§11, matrica, README)
5. sargo pašalinimas — PASKUTINIS commit'as
```

⚠️ **TAI REVIEW KRITERIJUS.** Jei `git log` rodo sargo pašalinimą anksčiau nei
5 žingsnyje, PR grąžinamas **nepriklausomai nuo testų būklės**: body sako, kad
sargo pašalinimas negali būti naudojamas ankstesniems testams „atrakinti". Testui,
kuriam reikia, kad sargo nebūtų, rašomas kelias tiesiai prieš store'ą arba testas
atidedamas — sargas nešalinamas anksčiau.

**Failai**
- `backend/utils/backupPolicy.js` — `TABLE_BY_TYPE` sprendimas **per-row** pagal
  eilutės `storage_type` (ne pagal aktyvų backend'ą)
- `backend/utils/pgDumpBackup.js` / `backend/utils/artifactBackup.js` — external objektų atsakomybė
- `backend/utils/jobStore/postgresStore.js:1623-1627` — **sargas pašalinamas**
- `docs/backup-runbook.md` §9a, §9c, §11
- `docs/security-test-matrix.md`, `README.md` apribojimų lentelė
- `backend/tests/artifactRestoreIntegrity.integration.test.js`

⚠️ **INLINE EILUTĖMS RESTORE VERIFIKACIJA NIEKO NEPATIKRINA, IR TAI RIBA.**

`verify()` grąžina `nepriklausomas: true|false`. External eilutėje `bytes` ir
`checksum` persistinti ATSKIRAI (PR-1 kolonos), tad objektas lyginamas su
nepriklausomu įrašu. `inline` eilutėje tų metaduomenų NĖRA (invariantas jų
reikalauja tik external šakoje), tad `verify()` gali tik perskaičiuoti iš to
paties `payload` — lygina reikšmę su savimi ir visada grąžina `ok: true`.

Tai nėra klaida, bet tai **kita garantija**. Praktinė pasekmė: procedūra,
tikrinanti „ar `storage_key` rodo į vientisą artefaktą", inline eilutėms neduoda
JOKIO patikrinimo — o mišrioje DB (po migracijos) tokių eilučių bus dauguma.
Restore ataskaita privalo skirti „patikrinta" nuo „nebuvo ko tikrinti", kitaip
pratybos praeis per lengvai ir tai atrodys kaip sėkmė.

**Restore verifikacija:** kiekvienai `job_results` eilutei su `storage_key`
kviečiamas `verify(key, {bytes, checksum})` su **DB pusėje persistintomis**
reikšmėmis (PR-1 kolonos, rašytos PR-4 metu). Missing arba nesutampantis →
fail-closed. `head()` čia nepakanka: `fs` backend'e jis checksum'o negrąžina
nebrangiai (žr. PR-2), tad vientisumo kelias yra atskiras ir sąmoningai brangesnis.
Body sąlyga: „ji persistinama kartu su reference DB pusėje write metu, o ne
skaičiuojama iš to paties objekto tikrinimo metu" — todėl verifikacija **niekada**
neskaičiuoja laukiamos reikšmės iš tikrinamo objekto.

**DoD**
- „`utils/backupPolicy.js` `TABLE_BY_TYPE` nebeteigia, kad `transcript` / `protocol` turinys yra `job_results` lentelėje, kai eilutės `storage_type` yra external; sprendimas priimamas pagal faktinį `storage_type`, ne pagal konfigūraciją."
- „Aiškiai apibrėžta external artifact backup/restore atsakomybė; peržiūrėti `docs/backup-runbook.md` §9a / §11 teiginiai bei atitinkami testai."
- „Restore/integrity testas įrodo, kad atkurtas DB `storage_key` nurodo į egzistuojantį ir teisingą artefaktą; missing/corrupt object failina uždarai."
- „Apibrėžta, IŠ KUR imama laukiama vientisumo reikšmė…"

⚠️ **PR-7 DoD FORMULUOJAMAS PER ATASKAITOS TURINĮ, NE PER LAUKO EGZISTAVIMĄ:**
restore verifikacija pateikia **atskirai** patikrintų ir NEPATIKRINAMŲ eilučių
skaičius.

⚠️ **SKIRSTOMA PAGAL `nepriklausomas`, NE PAGAL `ok`.** Inline `ok: true` yra
tikras, bet tuščias — jis reiškia „reikšmė sutampa su savimi". Ataskaita,
skaičiuojanti `ok`, mišrioje DB parodytų beveik 100 % ir būtų melas. `verify()` grąžina `nepriklausomas`, bet laukas, kurio niekas neskaito,
nėra garantija — lygiai kaip `neatkartojama` be `UnrecoverableError`. Mišrioje DB
inline eilučių bus dauguma, tad ataskaita, rodanti vien „patikrinta: N", skambėtų
kaip pilna patikra ir pratybos praeitų per lengvai.
- „Non-inline fail-closed sargo (`postgresStore.js:1623-1627`) pašalinimas yra **paskutinis** implementacijos žingsnis — po equality, schemos, hydration, completion/concurrency, erasure, migracijos ir backup/restore integracinių įrodymų. Sargo pašalinimas negali būti naudojamas ankstesniems testams „atrakinti"…"
- „Įvardyta, kad #157 PostgreSQL aktyvavimo barjero neatidaro…"

**§9.1**
| Sargas | Mutacija | Krenta? |
|---|---|---|
| checksum palyginimas | pašalinam palyginimą | taip — sugadintas objektas (vienas baitas) praeitų |
| dydžio palyginimas | pašalinam `bytes` patikrą | taip — sutrumpintas objektas praeitų |
| missing → fail-closed | `head()` `null` traktuojam kaip OK | taip — ištrintas objektas praeitų |

Kontrolė: nesugadintas objektas praeina — be jos verifikacija galėtų virsti
visada-„fail" ir taip pat nieko neįrodytų.

---

## 2. Ko įrodyti NEGALĖSIU (§14.1)

| Kriterijus | Kodėl | Kas jį uždarytų |
|---|---|---|
| Visi `postgresStore` keliai | Barjeras uždarytas; `DATABASE_URL` vietoje nėra | `REQUIRE_POSTGRES=1 npm run test:postgres` (CI) |
| `S3ArtifactStore` | Reikia MinIO | `docker compose -f docker-compose.minio.yml up -d && REQUIRE_MINIO=1 npm run test:s3` |
| I/O ne po užraktu | Reikia dviejų tikrų jungčių | tas pats `test:postgres` |
| Lenktynių testas | Vienas žalias paleidimas nieko neįrodo | N kartojimų CI; verdiktas „nepaneigta" |
| Hidratacijos nauda dydžiu | Reikia realaus duomenų kiekio | nematuojama šiame darbe; įvardijama kaip riba |

Nė vienas jų neverčiamas į `PASS` dėl to, kad „kodas atrodo teisingai".

---

## 3. A1–A4: priimti sprendimai

Keturi klausimai iš 1 revizijos atsakyti; čia jie fiksuojami kaip sprendimai su
viena eilute pagrindimo.

✅ **ORPHAN STRATEGIJOS KLAUSIMAS UŽDARYTAS** (Codex, #289; sprendimas priimtas po
PR-3 peržiūros): pasirinktas **variantas (b) — patvarus bandymų registras**. Pilna
formuluotė su ribomis: PR-4 skyrius „PRIIMTAS PR-4 SPRENDIMAS".

PR-4 nebeblokuojamas šio klausimo; jo formą (registras PRIEŠ `put()`) sprendimas
apibrėžia.

⚠️ **ANTRAS PR-4 REIKALAVIMAS, PAAIŠKĖJĘS PR-2 PERŽIŪROJE** (Codex, #290): inline
kelyje du bandymai dalijasi `job_id`, tad `ON CONFLICT (job_id) DO UPDATE SET
payload` perrašo nugalėtojo rezultatą **dar prieš** completion CAS. Vadinasi
inline rašymas privalo vykti **toje pačioje transakcijoje / CAS** kaip completion,
arba bandymai turi gauti izoliuotą saugojimą. Tai NE orphan klausimo dalis — čia
išorinio objekto nėra; tai lenktynių klausimas, ir jis sprendžiamas PR-4 kartu su
I/O tvarka.

**A1 — integrity kolonos eina į PR-1, ir external šakoje jos privalomos.**
`bytes` ir `checksum` gyvena `job_results` greta reference'o; privalomumas
išreiškiamas `CHECK` sąlyga external šakai. *Kodėl:* nullable kolonos atkartotų
tiksliai tą pačią spragą, kurią taisom — DB leistų external eilutę, su kuria
restore verifikacija neturėtų ko palyginti.

**A2 — checksum yra idempotencijos fast-path, ne lygybės semantika.**
Persistinamas atskira kolona, skaičiuojamas iš kanoninės eilutės prieš rašymą,
niekada neišvedamas iš object key ir niekada — iš saugyklos baitų. *Kodėl:*
tai to paties autoriteto išvesties santrauka; konflikto atveju laimi
`kanoninisRezultatas()`, ir nesutapimas yra defektas, ne dviprasmybė. Todėl
PR-4 turi **lygybės pariteto** įrodymą, o ne pasitikėjimą.

**A3 — `list(prefix)` į kontraktą NEĮEINA.**
Orphan aptikimas apibrėžiamas DB kryptimi: `storage_key` → `head()`. *Kodėl:*
priešinga kryptis reikalautų listing semantikos visuose trijuose backend'uose, o
DoD negali teigti platesnio aptikimo, nei pristatoma (§12.1). Riba užrašoma
`docs/artefact-lifecycle.md` ir **atskiru follow-up issue**, sukuriamu PR-5 metu.

**A4 — registras lieka statinis; vartotojai sprendžia pagal eilutės `storage_type`.**
`artefactInventory` aprašuose nebelieka fizinės vietos teiginio. *Kodėl:* po
migracijos DB bus mišri ilgą laiką, tad konfigūracija nėra egzistuojančių
rezultatų vietos autoritetas — tik naujų write'ų kryptis.

⚠️ **Prieštaravimų tarp naujo body ir AS-IS kodo neradau.** Vienintelė vieta,
kur naujas reikalavimas susikerta su esama forma, yra `head()` kaina `fs`
backend'e (§PR-2) — ji išsprendžiama atskiru `verify()` keliu, ne kontrakto
susilpninimu, ir tai HOW sprendimas, ne body pakeitimas.

---

## 4. Ko šis planas SĄMONINGAI nedaro

- neatidaro `POSTGRES_AKTYVAVIMAS_LEISTAS`;
- neredaguoja senų migracijų;
- nekuria antros lygybės taisyklės `common.js` atžvilgiu (checksum yra fast-path, A2);
- neplečia `ArtifactStore` kontrakto `list(prefix)` metodu (A3);
- nedaro registro priklausomo nuo konfigūracijos (A4);
- neprideda `storage_type`/`storage_key` į bendrą job modelį (memory/redis nepaliečiami, `jobStoreBackendContract` lieka žalias);
- nelaiko `inline` pereinamąja būsena;
- nešalina non-inline sargo anksčiau nei PR-7.
