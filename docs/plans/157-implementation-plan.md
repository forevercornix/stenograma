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
| `postgresStore.js:579-583` | ta pati | `SELECT_JOB` = `LEFT JOIN job_results` + `r.payload AS result` |
| `postgresStore.js:1499-1514` | ta pati | `listByFlag()` sąmoningai be prijungimo — precedentas |
| `postgresStore.js:778-785, 799` | ta pati | `rezultatoEilute()` po `FOR UPDATE OF j` |
| `postgresStore.js:989-1007` | ta pati | non-inline fail-closed sargas |
| `services/backupService.js:259-262` | ta pati | `countActiveJobs()` per `listAll()`, naudoja tik `status` |
| `services/lifecycleService.js:118, 393-394` | **`:129`, `:404-405`** | PR #288 įterpė `COVERED_CATEGORIES` predikatus; `STORED_IN_JOB_RECORD` logika nepakitusi |
| `utils/artefactScanner.js:99-100` | ta pati | `scan: null, reason: "saugoma job_record viduje"` |
| `utils/artefactInventory.js` | `:77`, `:98` | „…jobo įraše" / „…jobo rezultate" |
| `utils/backupPolicy.js:94,96` | ta pati | `transcript`/`protocol` → `"job_results"` |
| `utils/resultLimits.js:154` | ta pati | `MAX_RESULT_BYTES` = 20 MiB |

Papildomai patvirtinta, kas planą formuoja:

- `rowToJob` (`postgresStore.js:94`) rezultatą prikabina kaip `result: row.result`
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

PR-7 yra vienintelis, kuris liečia `postgresStore.js:989-1007`.

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
put(key, value)      → { key, bytes, checksum }
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

**DoD, kuriuos uždaro**
- „Vienas `ArtifactStore` production boundary; business/service sluoksnis neatlieka tiesioginio filesystem/S3 I/O."
- „Inline, filesystem ir S3-compatible implementacijos praeina tą patį `artifactStoreContract`."
- „Eksplicitiškai pasirinkto `fs` / `s3` backend'o konfigūracija validuojama startup metu fail-fast…"

**§9.1:** startup validacijos testas paleidžia **tikrą** `selectBackend({ARTIFACT_STORE_BACKEND:"fs"})` be root konfigūracijos ir laukia `throw`; pašalinus patikrą — grąžintų `inline` ir testas **krenta**. Kontrolė: be `ARTIFACT_STORE_BACKEND` startas `inline` režimu **privalo praeiti** (inline nėra fallback, bet yra teisėtas numatytasis).

⚠️ **UNVERIFIED:** `S3ArtifactStore` elgesys. Vietoje neįrodomas.
`REQUIRE_S3=1 MINIO_ENDPOINT=... npm run test:postgres` (arba naujas `test:s3`) —
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

**Ką palieka veikiantį:** external completion veikia `fs` backend'e; sargas
(`postgresStore.js:989-1007`) **dar lieka**, nes erasure ir backup keliai
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

### ⚠️ ATVIRAS PR-4 SPRENDIMAS: orphan'ai su attempt-unique raktu

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

Trys variantai PR-4:

| | Variantas | Kaina |
|---|---|---|
| a | Erasure trina pagal **prefiksą** (`results/<jobId>/`) | Tai `list`-ekvivalentas: A3 riba turėtų būti PERRAŠYTA, ne apeita per kitą metodo vardą |
| b | **Patvarus bandymo registras:** `attemptId` įrašomas į DB PRIEŠ `put()` | Orphan tampa matomas DB kryptimi; kaina — vienas `INSERT` prieš kiekvieną rašymą |
| c | Riba pripažįstama ir fiksuojama | `docs/artefact-lifecycle.md` + follow-up issue; GDPR pusėje silpniausias |

**Rekomendacija: (b).** Ji vienintelė išlaiko A3 („DB kryptis") nepakeistą ir tuo
pat metu padaro orphan'ą aptinkamu: jei `attemptId` yra registre, bet nėra
`job_results` nuorodos, objektas turi savininką ir adresą. (a) reikštų tylų A3
apėjimą — `list(prefix)` grįžtų kitu vardu; (c) paliktų transkripciją saugykloje
po ištrynimo.

⚠️ **SPRENDIMAS PRIIMAMAS PR-4 PRADŽIOJE, NE PABAIGOJE.** Jis keičia rašymo kelio
formą (registras prieš `put()`), tad įterptas vėliau reikštų perrašymą.

Iki tada lieka ir senoji riba: objektas, parašytas proceso, kuris krito prieš bet
kokią DB transakciją, be varianto (b) neturi jokio detektoriaus — DB krypties
skenavimas jo nemato pagal apibrėžimą.

`put()` vyksta **prieš** `inTransaction()`, ne jo viduje: tai išsprendžia
`rezultatoEilute()` po `FOR UPDATE OF j` (`postgresStore.js:778-785, 799`) be
tinklo I/O po užraktu.

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

**Failai**
- `backend/utils/jobErasure.js` — external objekto šalinimas per `ArtifactStore`
- `backend/services/lifecycleService.js` — `STORED_IN_JOB_RECORD` šaka (`:129`, `:404-405`)
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
hidratacijos riba nepažeidžiama: tai metaduomenys, ne turinys. `rowToJob()` juos
pateikia atskiru lauku (pvz. `job.resultStorage`), aiškiai atskirtu nuo
`job.storageKey`.

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
Sprendimas: migracija leidžiama su **stebėtoju antroje jungtyje**, kuris cikle
(`READ COMMITTED`) skaito `job_results` ir kiekvieną matytą eilutę tikrina prieš
invariantą. Pažeidimas → testas krenta.

⚠️ **MUTACIJA PRIVALO SKALDYTI TRANSAKCIJĄ, NE TIK SAKINĮ** (Codex, #289).
Ankstesnė formuluotė žadėjo, kad `UPDATE storage_key` + `UPDATE payload = NULL`
du žingsniais bus pagauta — bet jei abu vyksta TOJE PAČIOJE transakcijoje,
antroji jungtis `READ COMMITTED` režimu tarpinės būsenos nemato IŠ VISO: iki
commit'o ji regi seną eilutę, po jo — galutinę. Tokia mutacija stebėtojo
nesulaužytų, ir testas būtų atrodęs stipresnis, nei yra.

Teisinga mutacija: du `UPDATE` **atskirose transakcijose** (arba `COMMIT` tarp
jų) → stebėtojas pagauna commit'intą tarpinę būseną → **krenta**.

⚠️ IŠ TO SEKA IR TIKSLUS TEIGINYS, KURĮ TESTAS ĮRODO: „nėra **commit'intos**
formos pažeidžiančios būsenos". Tai lygiai tas reikalavimas, kurį formuluoja
body („commit'inta dalinai pakeisto trejeto būsena negalima"), ne stipresnis.
Vienos transakcijos vidinės tarpinės būsenos joks išorinis stebėtojas
neįrodys — ir jų įrodinėti nereikia, nes jos niekam nematomos.
⚠️ Riba užrašoma: stebėtojas įrodo, kad pažeidimo **nepastebėta**, ne kad jo
neįmanoma. Tai stipriau nei statinė patikra ir silpniau nei formalus įrodymas.

---

### PR-7 — Backup/restore, dokumentai, sargo pašalinimas

**Ką palieka veikiantį:** visą grandinę; tik čia dingsta fail-closed sargas.

**Vidinė commit'ų tvarka — privaloma, ne rekomenduojama**

```
1. backup/restore implementacija (be sargo pašalinimo)
2. integrity testai (missing / corrupt / kontrolė)
3. pilna regresija + integraciniai įrodymai (postgres + MinIO rinkiniai žali)
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
- `backend/utils/jobStore/postgresStore.js:989-1007` — **sargas pašalinamas**
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
skaičius. `verify()` grąžina `nepriklausomas`, bet laukas, kurio niekas neskaito,
nėra garantija — lygiai kaip `neatkartojama` be `UnrecoverableError`. Mišrioje DB
inline eilučių bus dauguma, tad ataskaita, rodanti vien „patikrinta: N", skambėtų
kaip pilna patikra ir pratybos praeitų per lengvai.
- „Non-inline fail-closed sargo (`postgresStore.js:989-1007`) pašalinimas yra **paskutinis** implementacijos žingsnis — po equality, schemos, hydration, completion/concurrency, erasure, migracijos ir backup/restore integracinių įrodymų. Sargo pašalinimas negali būti naudojamas ankstesniems testams „atrakinti"…"
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
| `S3ArtifactStore` | Reikia MinIO | `docker compose -f docker-compose.minio.yml up -d && REQUIRE_S3=1 npm run test:s3` |
| I/O ne po užraktu | Reikia dviejų tikrų jungčių | tas pats `test:postgres` |
| Lenktynių testas | Vienas žalias paleidimas nieko neįrodo | N kartojimų CI; verdiktas „nepaneigta" |
| Hidratacijos nauda dydžiu | Reikia realaus duomenų kiekio | nematuojama šiame darbe; įvardijama kaip riba |

Nė vienas jų neverčiamas į `PASS` dėl to, kad „kodas atrodo teisingai".

---

## 3. A1–A4: priimti sprendimai

Keturi klausimai iš 1 revizijos atsakyti; čia jie fiksuojami kaip sprendimai su
viena eilute pagrindimo.

⚠️ **BET VIENAS KLAUSIMAS LIEKA ATVIRAS, IR JIS NAUJAS** (Codex, #289): orphan
strategija su attempt-unique raktu (PR-4 skyrius „ATVIRAS PR-4 SPRENDIMAS").
A1–A4 uždaryti, tačiau rakto schemos pakeitimas atidarė klausimą su GDPR
pasekme — objektas, likęs po kritusio bandymo, išgyvena job'o ištrynimą. Trys
variantai užrašyti, rekomendacija yra (b), bet **sprendimas nepriimtas**.

Kol jis nepriimtas, PR-4 negali prasidėti: pasirinkimas keičia rašymo kelio formą.

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
