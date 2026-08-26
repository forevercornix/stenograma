# Saugumo ir privatumo testų matrica

Šis dokumentas yra GDPR issue #15 rezultatas. Jis atsako į vieną klausimą:
**kuris testas saugo kurią garantiją, ir iš kur žinom, kad jis realiai ją saugo.**

Trečias stulpelis yra svarbiausias. Testas, kurio niekas nebandė sulaužyti, yra
teiginys, ne įrodymas — šioje sesijoje ne kartą pasitaikė testų, kurie praeidavo
ir tada, kai tikrinama savybė buvo pašalinta.

`scripts/check-security-matrix.mjs` tikrina, kad kiekvienas čia minimas testų
failas realiai egzistuotų ir kad kiekvienas `privacy`/`security` rinkinio failas
būtų paminėtas. Be to matrica ilgainiui virstų sąrašu to, ką kažkada turėjom.

---

## GDPR #4 — automatinė PII redakcija

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Aptinkami LT asmens kodai, el. paštas, telefonai, IBAN | `piiRedaction` | Ribos prie brūkšnelio: `AK-39001010000` praeidavo neredaguotas |
| Vardai NEREDAGUOJAMI (sprendimas, ne praleidimas) | `piiRedaction` | — (dokumentuota riba) |
| Redakcija fail-closed: be komponento tiekėjas nekviečiamas | `redactionEnforcement`, `failClosedMatrix` | `_tryLoadArtefacts` grąžinimas → tiekėjas kviečiamas be guard'o |
| Trūkstamas redaguotas turinys nevirsta originalu | `failClosedMatrix` | Fallback į originalą LLM ir eksporto keliuose → krinta 2+2 testai |
| Guard tikrina artefakto **variantą**, ne prielaidą | `redactionEnforcement` | Struktūrinis: privalomas `require`, ne `try/catch` |
| Kategorijos konfigūruojamos; tuščias sąrašas atmetamas | `piiRedaction`, `privacyConfig` | Tuščio sąrašo patikros pašalinimas |
| Auditas fiksuoja būseną ir baigtį be PII reikšmių | `redactionEnforcement`, `auditLog` | Konteksto fallback pašalinimas |
| Repair retry nesugadina šaltinio metaduomenų | `redactionEnforcement`, `redactionParity4.route` | `lastRedactionAudit` grąžinimas → `redactionStats: {}` |
| Klaidos nenutekina transkripcijos | `redactionErrorLeak.route` | — |
| API ir worker keliai redaguoja vienodai | `redactionParity.route` | — |
| Placeholder'iai atvaizduojami kaip tekstas | `frontend/src/RedactionXss.test.jsx` | `dangerouslySetInnerHTML` įvedimas |

## GDPR #5 — konfigūruojamas privatumo režimas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Politika užšaldyta ir vienoda visiems komponentams | `privacyPolicy` | — |
| Netinkama konfigūracija stabdo startą | `privacyConfig`, `securityBaseline.route` | Kategorijų validacijos pašalinimas |
| Išoriniai tiekėjai blokuojami pagal politiką | `providerPrivacy`, `redactionEnforcement` | — |
| Diagnostika be paslapčių | `privacyConfig` | — |

## GDPR #6 — retencija ir ištrynimo teisė

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Jobo ištrynimas pašalina VISUS pėdsakus | `jobErasure` | — |
| Audito įrašai siejami su subjektu ir ištrinami | `auditErasure.service` | — |
| Ištrynimas atsparus daliniams gedimams | `deletionResilience` | — |
| Ištrynimas išgyvena restartą | `redisConcurrency.integration` | `remove()` no-op |

## GDPR #8 — originalus ir redaguotas eksportas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Variantas privalomas, be numatytosios reikšmės | `exportVariants.route` | Numatytojo varianto įvedimas → krinta 6 testai |
| Nežinoma reikšmė atmetama, ne priartinama | `exportVariants.route` | „Priartinimas prie panašiausios" validatoriuje |
| Politika gali uždrausti, bet ne pakeisti variantą | `exportVariants.route`, `exportPolicy` | — |
| Failo vardas neša variantą ir yra saugus | `exportVariants.route` | Varianto pašalinimas iš vardo |
| Formatams tinkamas ekranavimas (CSV formulės) | `exportVariants.route` | — |
| Eksporto auditas su `variant`/`format`/`outcome` | `observabilityEvents.route`, `exports.route` | `variant` lauko pašalinimas |
| UI: du variantai, patvirtinimas originalui | `frontend/src/ExportVariants.test.jsx` | Patvirtinimo pašalinimas → krinta 2 testai |

## GDPR #13 — saugus priėmimas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Kelio traversal negalimas | `uploadPath` | — |
| Bendra multer konfigūracija abiem maršrutams | `uploadStorage` | Struktūrinis: `multer.diskStorage` maršrutuose |
| Laikini failai valomi | `uploadIngestion.route`, `audioCleanup` | — |
| Atmesti įkėlimai fiksuojami be failo vardo | `observabilityEvents.route` | MIME sanitizacijos pašalinimas |
| Failo TURINYS tikrinamas, ne tik plėtinys | `audioMagicBytes` | — |
| Saugyklos raktai generuojami serveryje | `fileStorage` | — |

## GDPR #14 — API saugumo bazė

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Saugumo antraštės visiems atsakymams | `securityBaseline.route` | Helmet pašalinimas |
| CORS allow-list, kilmės validuojamos | `securityBaseline.route` | Kilmių tikrinimo pašalinimas → krinta 2 |
| Kūno limitai | `securityBaseline.route` | — |
| Validacija: vienas klaidų formatas, be kliento teksto | `securityBaseline.route` | Žalio `issue.message` grąžinimas |
| Nežinomi laukai atmetami | `securityBaseline.route` | — |
| Schemos atitinka serviso parašą | `securityBaseline.route` | Laukų pašalinimas iš schemos |
| **Autentifikacija visuose maršrutuose** | `criticalGuarantees.route` | `apiKeyAuth` pašalinimas → krinta 3–4 testai |
| **Middleware tvarka: auth prieš validaciją** | `criticalGuarantees.route` | Tvarkos sukeitimas → krinta 1; įkėlimas prieš auth → krinta 1 |
| Readiness turi laiko ribą | `securityBaseline.route` | `withTimeout` pašalinimas |
| `API_KEY` blokuoja neautorizuotą prieigą | `security.route` | — |
| Tiekėjo perrašymas tik su `ALLOW_PROVIDER_OVERRIDE` | `providerOverride.route` | — |
| Tiekėjų registro paieška be prototype injection | `providerRegistryLookup` | CodeQL `js/unvalidated-dynamic-method-call` |
| Vidinės klaidos sanitizuojamos prieš atsakymą | `errorSanitization.route` | — |
| Startup validacija stabdo nesaugią konfigūraciją | `startupChecks` | Kategorijų validacijos pašalinimas |
| Init vyksta PRIEŠ `listen` | `startupOrder` | — |
| Išoriniai kvietimai turi timeout | `httpClient.timeout` | — |
| Worker'iai neprieina prie draudžiamų operacijų | `workerGuard` | — |

## GDPR #16 — CI ir tiekimo grandinė

| Garantija | Patikra | Mutacijos įrodymas |
|---|---|---|
| Workflow teisės, `pull_request_target`, paslapčių vieta | `scripts/check-workflow-policy.mjs` | Write teisės, `secrets` env, `secrets: inherit` |
| Action'ų prisegimas, panaudojami workflow | `scripts/check-workflow-policy.mjs` | Nepatikimas šaltinis be SHA |
| `persist-credentials: false` | `scripts/check-workflow-policy.mjs` | Nuėmimas → krinta |
| Dependabot poros ir sintaksė | `scripts/check-workflow-policy.mjs` | Įrašo ištrynimas, sintaksės klaida |
| Priklausomybių auditas blokuoja PR | `ci.yml` `dependency-audit` | Rado realų `brace-expansion` high radinį |

## #18 — autentifikacija ir prieigos kontrolė (PR1: pamatas)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Slaptažodžiai saugomi TIK kaip scrypt maiša su atsitiktine druska | `authFoundation` | Ta pati maiša tarp generavimų (turi skirtis) |
| Netinkamas `AUTH_USERS` formatas stabdo startą | `authFoundation` | Nežinoma rolė, dublikuotas vardas |
| Netinkami sesijos laiko limitai stabdo startą | `authFoundation` | `SESSION_IDLE_TIMEOUT_MINUTES=abc` |
| Nežinomas vartotojas ir blogas slaptažodis atsako VIENODAI (nėra username enumeration) | `authFoundation`, `authRoutes.route` | Atsako laiko ir atsakymo turinio palyginimas |
| Sesija baigiasi idle ir absoliučiu limitu, NEATGYJA | `authFoundation` | Expiry patikros pašalinimas |
| Revokacija (logout, `destroyAllForUser`) realiai pašalina sesiją | `authFoundation`, `authRoutes.route` | `destroy()` pavertimas no-op |
| Sesijos cookie: `HttpOnly`, `SameSite=Lax`, `Secure` tik produkcijoje | `authRoutes.route` | — |
| 401 atsakymas vienodas visoms priežastims (nėra, pasibaigusi, suklastota) | `authRoutes.route` | — |
| Slaptažodis niekada nepatenka į atsakymą ar auditą | `authRoutes.route` | — |
| Prisijungimo bandymai riboti pagal IP+vardą, IPv6-saugiai | `authRoutes.route` | Struktūrinė patikra (`ipKeyGenerator`) |
| Validacija: vienas formatas, nežinomi laukai atmetami | `authRoutes.route` | — |
| `verifyPassword` niekada nemeta klaidos (griežtas N/r/p/druskos/maišos tikrinimas) | `authFoundation` | Netikslus N/r/p, ne-hex druska, netinkamas maišos ilgis |
| Startup atmeta pavojingus scrypt parametrus TA PAČIA logika kaip runtime | `authFoundation` | `scrypt$999999999$999999$1$...` praeidavo startą |
| Login limitas: DU nepriklausomi (IP-only + IP+vardas su canonicalizacija) | `authRoutes.route` | Vardo variantų (tarpai/registras) apėjimo bandymas HTTP lygiu |
| Sugadinta cookie (blogas procentinis kodavimas) grąžina 401, ne 500 | `authRoutes.route` | `try/catch` pašalinimas aplink `decodeURIComponent` |
| Pasibaigusios sesijos pašalinamos net be pakartotinio naudojimo (periodinis + kiekvieno `create()` sweep) | `authFoundation` | Sweep kvietimo pašalinimas iš `create()` |
| Login rate-limit kintamieji validuojami startup metu (ne `parseInt` tyliai) | `authFoundation` | Startup patikros pašalinimas |

### #18 PR2 — rolėmis grįsta autorizacija

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Deny-by-default: nežinoma rolė ar leidimas visada atmetami | `rbac.route` | `hasPermission` pavertimas `true` → krinta 5 testai |
| Operatorius NEGALI ištrinti darbo (403, ne 401) | `rbac.route` | Leidimo patikros pašalinimas iš DELETE |
| Eksporto leidimas priklauso nuo VARIANTO, ne maršruto | `rbac.route` | Operatorius negauna `original` |
| Sesija turi PIRMENYBĘ prieš bendrą raktą (nėra teisių eskalacijos) | `rbac.route` | Pirmenybės pašalinimas → krinta 3 testai |
| Auditas: sesija su `audit:read` ARBA `x-audit-key`, operatoriui – nė vienas | `rbac.route` | — |
| Esamas `x-audit-key` kelias veikia be sesijos (atgalinis suderinamumas) | `rbac.route` | — |
| 401 vs 403 atskirti teisingai | `rbac.route` | — |
| Kiekvienas maršrutas turi IR autentifikaciją, IR leidimo patikrą | `criticalGuarantees.route` | `requirePermission` pašalinimas iš DELETE |
| `API_KEY_ROLE` validuojamas startup metu | `authFoundation` | — |

### #18 PR3 — konteksto propagavimas ir revokacija

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Jobas neša aktoriaus ID, rolę ir šaltinį | `workerAuthorization` | `actorRole` neįrašymas |
| Jobo įraše NĖRA slaptažodžių, sesijos ID ar cookie | `workerAuthorization` | — (tikrinamas visas serializuotas įrašas) |
| Pašalintas vartotojas nebeįvykdo eilėje laukiančio jobo | `workerAuthorization` | Pasitikėjimas užšaldyta role → krinta 4 testai |
| Sumažinta rolė atima teisę, nors jobe rašo senoji | `workerAuthorization` | Ta pati |
| Logout NENUTRAUKIA jau pradėto darbo (sąmoninga riba) | `workerAuthorization` | — |
| Jobai be aktoriaus (iki #18) vis tiek vykdomi | `workerAuthorization` | — |
| Abu vykdymo keliai (inline + BullMQ) tikrina teises vienodai | `workerAuthorization` | Autorizacijos pašalinimas iš worker'io |
| Atmestas vykdymas audituojamas be kredencialų | `workerAuthorization` | — |

### #18 PR4 — sąsaja, regresijos ir dokumentacija

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Neprisijungus rodoma prisijungimo forma, ne pagrindinis UI | `frontend/src/RolePermissions.test.jsx` | — |
| Operatorius nemato originalo eksporto; administratorius mato | `frontend/src/RolePermissions.test.jsx` | Leidimo sąlygos nuėmimas |
| **UI nėra apsauga:** backend 403 parodomas kaip teisių, ne veiksmo klaida | `frontend/src/RolePermissions.test.jsx` | 403 apdorojimo pašalinimas |
| 401 grąžina į prisijungimą su paaiškinimu (ne „neturite teisės") | `frontend/src/RolePermissions.test.jsx` | — |
| Leidimai ateina iš backend'o, ne skaičiuojami pagal rolės pavadinimą | `frontend/src/RolePermissions.test.jsx` | — |
| Tiesioginis API kvietimas apeinant UI gauna 403 | `rbac.route` | — |
| `/api/auth/me` leidimai SUTAMPA su tuo, ką serveris vykdo | `rbac.route` | — |

⚠️ **Frontend leidimai valdo tik atvaizdavimą.** Paslėptas mygtukas nėra
apsauga – tikroji riba yra `middleware/authorize.js`. Būtent todėl regresijos
testai tikrina tiesioginius API kvietimus, o ne vien UI elgesį.

Diegimo instrukcijos: [`docs/auth-deployment.md`](auth-deployment.md).

⚠️ **Revokacijos modelis:** teisės **perskaičiuojamos vykdymo metu**, ne
užšaldomos kuriant jobą. Kaina: rolės sumažinimas nutraukia jau eilėje esančius
darbus. Tai sąmoningai pasirinkta pusė — geriau nutraukti teisėtą darbą, nei
įvykdyti neteisėtą.

⚠️ **Žinoma riba:** `API_KEY_ROLE` pagal nutylėjimą yra `administrator`
(atgalinis suderinamumas – iki #18 rakto turėtojas galėjo viską). Kol taip yra,
RBAC **neriboja** bendro rakto turėtojų. Startup įspėjimas apie tai praneša;
realiam atskyrimui reikia `API_KEY_ROLE=operator` arba perėjimo prie sesijų.

⚠️ **Nuosavybės patikrų NĖRA:** rolė sprendžia, KOKIUS veiksmus galima atlikti,
bet ne SU KIENO duomenimis. Bet kuris administratorius gali ištrinti bet kurį
darbą. Tai lieka už #18 ribų.

## GDPR #17 — observability ir koreliacija

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Request ID kiekvienai užklausai, griežta kliento ID validacija | `requestContext.route` | Validacijos susilpninimas → krinta 2 |
| ID propaguojamas į jobus ir **vykdymą** | `requestContext.route`, `redisConcurrency.integration` | Konteksto perdavimo nutraukimas |
| Kontekstas atkuriamas per realų vykdymo kelią | `redisConcurrency.integration` | `jobRunner` perduoda `null` → krinta |
| Grandinė `queued → processing → provider → completed/failed` | `correlationChain.integration` | Nesėkmės grandies pašalinimas |
| `failed` tik galutinei nesėkmei, ne retry | `workerRetry` | Besąlyginis `failed` |
| Lygiagretūs srautai nesumaišo ID | `correlationChain.integration`, `redisConcurrency.integration` | — |
| Struktūruotas logas, `msg` ir `data` sanitizuojami | `logger` | `msg` sanitizacijos pašalinimas |
| IP tik kaip pseudonimas | `rateLimit.route`, `logger` | Žalias `req.ip` → krinta |
| Auditas be turinio | `auditLog`, `correlationChain.integration` | — |
| Aktoriaus atspaudas atsparus brute-force | `requestContext.route` | Grynas SHA-256 / HMAC vietoj scrypt |

---

## #19 — artefaktų inventorius ir gyvavimo ciklas (PR1: modelis)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Kiekvienas artefakto tipas turi pilną apibrėžimą (savininkas, klasė) | `artefactInventory` | — |
| Išvedimo grafe nėra ciklų, `derivedFrom` nurodo tikrus tipus | `artefactInventory` | — |
| Eksportas atsekamas iki įkelto audio (pilnas grafas) | `artefactInventory` | — |
| Efemeriški artefaktai nesaugomi (nėra antros PII kopijos) | `artefactInventory` | — |
| **Iš `deleted` nėra kelio atgal** | `artefactInventory` | `DELETED → ACTIVE` leidimas → krinta 2 testai |
| **Ištrynimas privalo eiti per `pending_deletion`** (tombstone pirma) | `artefactInventory` | Tiesioginio `ACTIVE → DELETED` leidimas |
| Perėjimai deny-by-default | `artefactInventory` | — |
| Artefaktas be savininko atmetamas (nėra našlaičių) | `artefactInventory` | — |
| Inventorius išgyvena Redis serializaciją | `artefactInventory` | — |

Modelis ir grafas: [`docs/artefact-lifecycle.md`](artefact-lifecycle.md).

### #19 PR2 — koordinuotas ištrynimas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Žyma (tombstone) uždedama **prieš** šalinimą | `lifecycleDeletion` | Žymos pašalinimas → krinta 5 testai |
| Žyma **išgyvena** jobo įrašą | `lifecycleDeletion` | — |
| Pakartotinis ištrynimas nėra klaida (idempotentiškas) | `lifecycleDeletion` | Idempotentiškumo patikros pašalinimas |
| **Po dalinio ištrynimo pakartojimas realiai trina** | `lifecycleDeletion` | „Bet kokia žyma trumpina kelią" → krinta 2 |
| **Lygiagretus kvietimas LAUKIA, o ne skelbia sėkmę** | `lifecycleDeletion` | Koordinavimo pašalinimas |
| `pending` blokuoja kūrimą, bet leidžia kartoti | `lifecycleDeletion` | — |
| `deleted` yra **galutinė** – atšaukti negalima | `lifecycleDeletion` | `DELETED → FAILED` leidimas |
| `failed → deleted` leidžiamas (retry kelias) | `lifecycleDeletion` | Retry kelio uždarymas → krinta 2 |
| `completedAt` yra `null`, kol nepatvirtinta | `lifecycleDeletion` | — |
| Aktorius realiai patenka į auditą (ir be HTTP konteksto) | `lifecycleDeletion` | — |
| `ENOENT` ištrynime = sėkmė, ne gedimas | `lifecycleDeletion` | — |
| Žymos TTL validuojamas startup metu | `lifecycleDeletion` | — |
| Transkripcija ir protokolas seka konteinerį | `lifecycleDeletion` | — |
| Laikini artefaktai pažymėti kaip dar nepatikrinti | `lifecycleDeletion` | — |
| Stabilus struktūrizuotas formatas visiems atvejams | `lifecycleDeletion` | — |
| Kartotini ir galutiniai gedimai atskiriami | `lifecycleDeletion` | — |
| Efemeriškos kategorijos rodomos atskirai | `lifecycleDeletion` | — |
| **Atsakymuose nėra kelių, raktų ar klaidų tekstų** | `lifecycleDeletion` | `errors` pridėjimas į atsakymą |
| Abu DELETE maršrutai kviečia **vieną** servisą | `lifecycleDeletion` | Tiesioginis `eraseJob` apeinant servisą |
| Auditas fiksuoja aktorių, rezultatą ir laiką be turinio | `lifecycleDeletion` | — |

### #196 — nepavykę ištrynimo bandymai apskaitomi

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Eskalacija įvyksta NET kritus `jobStore.update()`** | `deletionRetryPersistence` | Grąžinus `.catch(() => {})` → krinta 3 |
| **Bandymų skaitiklis auga be persistencijos** | `deletionRetryPersistence` | Pašalinus atsarginį skaitiklį → krinta |
| **Kritus saugyklai pakartojimas ATIDEDAMAS, ne kartojamas** | `deletionRetryPersistence` | Atsarginėje aibėje laikomas IR terminas: be jo `_isDue()` praleistų kiekvieną sweep'ą, ir outage'o metu neveikianti saugykla būtų daužoma be pertraukos. Mutacija: nesaugant termino arba jo neskaitant `_isDue()` → krinta |
| **Ta pati garantija galioja AUDIO valymo keliui** | `deletionRetryPersistence` | Helperis bendras abiem keliams; pirmoji testų versija tikrino tik ištrynimą |
| **Po visų testų `jobStore` NEPALIKTAS perimtas** | `deletionRetryPersistence` | Nešvarus cleanup neduoda kritimo tame teste, kuris jį sukėlė — jis pasireiškia KITAME, ir tik tam tikra tvarka. Mutacija: išsaugojus mock'ą vietoj tikros funkcijos → krinta |
| **Be `storageKey` bandymas NESKAIČIUOJAMAS** | `deletionRetryPersistence` | Jokio trynimo nebuvo — skaitiklio didinimas klaidingai artintų eskalaciją. Mutacija: pridėjus `audio_cleanup_attempts` į patch'ą → krinta |
| Nepavykęs įrašymas patenka į logą su `jobId` ir kodu | `deletionRetryPersistence` | |
| Pavykus įrašymui atsarginis skaitiklis išvalomas | `deletionRetryPersistence` | |

⚠️ **PRARYJAMAS BUVO BŪTENT TAS ATNAUJINIMAS, KURIS DARO GEDIMĄ MATOMĄ.**
`jobStore.update()` dažniausiai krinta per tą patį Redis sutrikimą, kuris ir
sukėlė ištrynimo nesėkmę. Tada `deletion_attempts` liko `0`,
`next_attempt_at` neatnaujintas (jokio backoff), o
`MAX_ATTEMPTS_BEFORE_ALERT` **niekada nepasiekiamas** — GDPR ištrynimas
nepavyksta tyliai.

Vienintelis apsauginis mechanizmas negali priklausyti nuo to paties komponento,
kuris ką tik krito, todėl skaitiklis dubliuojamas atmintyje. Restartas ją
praranda — priimtina: persistintas laukas vėl tampa autoritetu, o eskalacija tik
atidedama.

---

### #19 PR3 — apsauga nuo atkūrimo po ištrynimo

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| `jobStore.update` atmeta atnaujinimą po ištrynimo | `deletionEnforcement` | Apsaugos pašalinimas → krinta 3 |
| BullMQ worker'is nepradeda ištrinto jobo | `deletionEnforcement` | Patikros pašalinimas → krinta 2 |
| Inline kelias elgiasi **vienodai** | `deletionEnforcement` | Patikros pašalinimas → krinta 1 |
| Ištrynimas vykdymo metu neleidžia įrašyti rezultato | `deletionEnforcement` | — |
| `pending` ir `failed` žymos irgi blokuoja | `deletionEnforcement` | — |
| Apėjimui reikia **simbolio**, `true` neveikia | `deletionEnforcement` | Boolean apėjimo grąžinimas |
| Vidinį raktą mini tik leidžiami failai | `deletionEnforcement` | — |
| Worker'is nemeta klaidos (BullMQ nekartotų amžinai) | `deletionEnforcement` | — |
| Retencija paleidžiama iškart po starto | `deletionEnforcement` | — |
| Žymų restarto riba **užrašyta kode** | `deletionEnforcement` | — |

### #19 PR4 — E2E patikra per tikrus produkcijos kelius

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Pilnas ciklas: įkėlimas → transkripcija → ištrynimas per **tikrus** maršrutus | `lifecycleE2E` | — |
| Po ištrynimo **inventoriaus skenavimas** neranda nuorodų | `lifecycleE2E` | Audito valymo išjungimas → krinta 4 |
| Audio pašalinamas iš **fizinės saugyklos** | `lifecycleE2E` | `fileStorage.del` išjungimas |
| Protokolo ir transkripcijos jobai netampa našlaičiais | `lifecycleE2E` | — |
| Eksportas nepalieka artefakto (efemeriškas) | `lifecycleE2E` | — |
| Pakartotinis ištrynimas duoda tą pačią būseną | `lifecycleE2E` | — |
| Ištrinto jobo ID negali būti atkurtas | `lifecycleE2E` | — |
| Atšaukimas nebaigus darbo palieka švarią būseną | `lifecycleE2E` | — |
| Atsakyme nėra kelių ar raktų (per **tikrą HTTP**) | `lifecycleE2E` | — |
| Testai **nenaudoja išgalvotų ID** | `lifecycleE2E` | — |
| **Kiekvienas** registro tipas turi skenavimo strategiją | `lifecycleE2E` | Strategijos pašalinimas → krinta 3 |
| Praleisti tipai turi priežastį, ne tylą | `lifecycleE2E` | Priežasties pašalinimas |
| Efemeriški tipai imami iš **registro**, ne strategijų sąrašo | `lifecycleE2E` | — |

⚠️ **Visi identifikatoriai gaunami iš realių HTTP atsakymų.** Testas su
išgalvotu `job_test_123` tikrintų savo paties fikciją ir „praeitų" net sulaužius
produkcijos kelią – tam yra atskira sąžiningumo patikra.

⚠️ **Žymos restarto neišgyvena** – saugykla tik atmintyje. Po restarto vėluojanti
eilės žinutė vėl galėtų kurti artefaktus.

⚠️ **Šis etapas nieko netrina.** Registras, būsenų modelis ir koreliacija yra
pagrindas koordinuotam ištrynimui, kuris ateina atskirai.

⚠️ **`sourceArtefactId` dar nevaliduojamas** – patikrai reikia viso inventoriaus
konteksto, o realūs artefaktai dar neregistruojami. Kitam etapui reikalingi
patikrinimai išvardyti `utils/artefactInventory.js` ir dokumentacijoje.

### #19 PR5 — dokumentacija kaip tikrinamas pažadas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Dokumento **lentelės** reikšmės sutampa su `.env.example` | `deletionDocumentation` | `24 → 48` dokumente |
| Kodo numatytoji `JOB_TTL_MINUTES` sutampa su dokumentuota | `deletionDocumentation` | — |
| Kiekvienas artefakto tipas paminėtas dokumente | `deletionDocumentation` | — |
| Visos ištrynimo ir žymos būsenos dokumentuotos | `deletionDocumentation` | — |
| **Kiekviena žinoma riba įvardyta** | `deletionDocumentation` | Ribos pašalinimas iš dokumento |
| Atsarginių kopijų riba nurodo į #20 | `deletionDocumentation` | — |
| Pseudonimizacija paaiškinta (kitaip paieška nieko neras) | `deletionDocumentation` | — |
| Dokumentuotas veiksmas nepavykus ištrynimui | `deletionDocumentation` | — |

Operacinės garantijos: [`docs/deletion-guarantees.md`](deletion-guarantees.md).

⚠️ **Dokumentas apie garantijas yra pažadas.** Pasenęs jis teigia daugiau, nei
sistema daro – tai pavojingiau nei trūkstama funkcija, nes kuria klaidingą
pasitikėjimą būtent ten, kur jo negalima turėti. Todėl jis tikrinamas testais.

## #20 — atsarginės kopijos (PR1: politika ir manifestas)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Politika **išvedama iš artefaktų registro**, ne rašoma atskirai | `backupPolicy` | „Viskas įtraukiama" → krinta 4 |
| Efemeriški artefaktai **niekada** nekopijuojami | `backupPolicy` | Ta pati |
| Laikini artefaktai nekopijuojami | `backupPolicy` | Ta pati |
| Eilės įrašas neįtraukiamas, nors persistent (su priežastimi) | `backupPolicy` | — |
| Kiekvienas tipas yra **tiksliai viename** sąraše | `backupPolicy` | — |
| Kopijos numatytai **išjungtos** | `backupPolicy` | — |
| Manifeste **nėra asmens duomenų** – tik metaduomenys | `backupPolicy` | — |
| Kūrimas atmeta tipus, kurių politika neleidžia | `backupPolicy` | Patikros pašalinimas |
| Validacija **fail-closed**: trūkstamas laukas atmeta kopiją | `backupPolicy` | — |
| **Naujesnė** kopija į senesnę sistemą atmetama | `backupPolicy` | Patikros pašalinimas |
| Kontrolinė suma aptinka pakitusį turinį | `backupPolicy` | — |
| `applicationVersion` atskiras nuo formato versijos | `backupPolicy` | Lauko pašalinimas → krinta 2 |
| Dokumentuota, kad suma **neapsaugo nuo tyčinio pakeitimo** | `backupPolicy` | — |
| Retencijos terminas **manifeste**, ne skaičiuojamas atkuriant | `backupPolicy` | — |
| `BACKUP_RETENTION_DAYS` validuojamas startup metu | `backupPolicy` | — |

### #20 PR2 — kopijavimas ir atkūrimas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Vykdomi darbai praleidžiami ir **užfiksuojami manifeste** | `backupRestore` | „Viskas įtraukiama" |
| Kopija apima `source_audio` – vienas režimas | `backupRestore` | — |
| Atkūrimo grandinė vykdoma **nuosekliai** (6 žingsniai) | `backupRestore` | — |
| Sugadintas turinys sustabdo atkūrimą | `backupRestore` | Sumos patikros pašalinimas |
| Sustojus grandinei sistema **lieka nepaliesta** | `backupRestore` | — |
| Naujesnis formatas ir nesuderinamas major atmetami | `backupRestore` | — |
| Minor/patch skirtumai leidžiami | `backupRestore` | — |
| **Ištrintas jobas NEGRĮŽTA iš kopijos** | `backupRestore` | Žymų patikros pašalinimas → krinta 2 |
| Saugyklos raktas iš kopijos validuojamas (kelio apėjimas) | `backupRestore` | Apsaugos pašalinimas |
| Kopijavimas ir atkūrimas audituojami su aktoriumi | `backupRestore` | — |
| Nepavykęs atkūrimas fiksuoja **žingsnį** | `backupRestore` | — |
| Audite ir rezultate nėra kelių, raktų ar turinio | `backupRestore` | — |
| **Auditas į kopiją nepatenka** (su eksplicitine priežastimi) | `backupRestore` | Neįtraukimo pašalinimas |
| Sena kopija su auditu **praleidžiama**, ne atkuriama | `backupRestore` | Audito atkūrimas |

⚠️ **Atkūrimas gerbia #19 ištrynimo žymas.** Be to atsarginė kopija taptų būdu
apeiti GDPR ištrynimą: pakaktų atkurti kopiją, kad ištrinti duomenys grįžtų.

### #20 PR3 — paslaptys, šifravimas ir atkūrimo validacija

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Paslapčių sąrašas **eksplicitinis**, ne pagal vardo šabloną | `backupSecurity` | — |
| Kiekviena paslaptis turi `unlocks` ir `rotation` | `backupSecurity` | — |
| Išorinės paslaptys atskirtos (rotacija per tiekėją) | `backupSecurity` | — |
| Aptinkamos **reikšmės**, ne vardai; trumpos ignoruojamos | `backupSecurity` | — |
| Šifravimas: **pakeistas turinys aptinkamas** (GCM žyma) | `backupSecurity` | — |
| **Kopija realiai šifruojama** srauto lygiu | `backupSecurity` | Šifravimo atjungimas → krinta 2 |
| Manifeste fiksuojama `encrypted` ir algoritmas | `backupSecurity` | — |
| Šifruota kopija atkuriama per pilną grandinę | `backupSecurity` | — |
| Netinkamas raktas neatkuria; raktas nepatenka į pranešimą | `backupSecurity` | — |
| Rotacija veikia **per tikrą srautą**, ne vien modulyje | `backupSecurity` | — |
| Kontrolinė suma dengia **šifruotą** turinį | `backupSecurity` | — |
| **Rotacija išsaugo senas kopijas** | `backupSecurity` | Ankstesnio rakto pašalinimas |
| Netinkamo ilgio raktas atmetamas, ne ištempiamas | `backupSecurity` | — |
| Kopija su paslaptimi **atmetama**; pranešime tik vardas | `backupSecurity` | Patikros išjungimas → krinta 2 |
| Netinkama konfigūracija sustabdo atkūrimą (**ta pati** kaip #14) | `backupSecurity` | — |
| Neišsaugojimo režimas blokuoja atkūrimą | `backupSecurity` | — |
| Įprastas režimas be Redis **neblokuojamas** | `backupSecurity` | — |
| Leidimų **lentelėje** kopijos priskirtos tik administratoriui | `backupSecurity` | Teisės suteikimas operatoriui |
| Kopijų maršruto **dar nėra** – garantija neįgyvendinta | `backupSecurity` | — |
| **Manifestas susietas su turiniu (AAD)** – klastojimas laužo dešifravimą | `backupSecurity` | AAD pašalinimas → krinta 2 |
| AAD pridėjimas **pakėlė formato versiją** į `v2` | `backupSecurity` | Grąžinimas į `v1` → krinta 16 |
| Nebepalaikomas `v1` atmetamas su konkrečia priežastimi | `backupSecurity` | — |
| **Manifesto downgrade** (`encrypted: true → false`) aptinkamas | `backupSecurity` | Aptikimo išjungimas |
| `encrypted` privalo būti griežtas boolean | `backupSecurity` | Tipo patikros išjungimas |
| `contents` klastojimas laužo dešifravimą; tvarka nesvarbi | `backupSecurity` | — |
| AAD schema susieta su formato versija | `backupSecurity` | — |
| Turinio sukeitimas tarp kopijų atmetamas | `backupSecurity` | — |
| Nepalaikomas ar nenuoseklus algoritmas atmetamas | `backupSecurity` | — |
| Netinkama envelope struktūra atmetama **prieš ciphertext base64 dekodavimą** | `backupSecurity` | — |
| **`v2` reikalauja manifesto** – vienareikšmė formato sutartis | `backupSecurity` | Privalomumo pašalinimas → krinta 2 |
| `v1` atmetamas su konkrečia priežastimi **pilname sraute** | `backupSecurity` | — |
| `contents` schema tikrinama griežtai prieš AAD | `backupSecurity` | Patikros išjungimas |
| **Paslaptys aptinkamos jau kuriant** kopiją | `backupSecurity` | Patikros išjungimas → krinta 2 |
| Kopijų raktai yra paslapčių inventoriuje | `backupSecurity` | Rakto pašalinimas |
| **Šifruota** kopija irgi negrąžina ištrinto jobo (#19) | `backupSecurity` | — |
| Rotacijos kelias irgi gerbia žymas | `backupSecurity` | — |
| Šifravimo raktai validuojami startup metu | `backupSecurity` | — |

⚠️ **Šifravimas nepakeičia prieigos kontrolės.** Kas turi raktą, turi duomenis;
raktas privalo gyventi atskirai nuo kopijų.

⚠️ **Envelope dydžio patikra nėra viso failo apsauga.** Ji vyksta prieš
`base64` dekodavimą, bet iki tol failas jau perskaitytas ir išparsintas. Viso
failo riba priklauso įėjimo taškui, kurio dar nėra.

### #20 PR4 — kopijų endpoint'ai

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Anonimas negauna nei kūrimo, nei atkūrimo (**401**) | `backupRoutes.route` | `AUTH_USERS` patikros pašalinimas → krinta 2 |
| Operatorius negauna nei vieno (**403**) | `backupRoutes.route` | Leidimo pašalinimas → krinta 2 |
| Leidimai tikrinami **atskirai** kūrimui ir atkūrimui | `backupRoutes.route` | — |
| Serveris kopijų **nesaugo** | `backupRoutes.route` | — |
| Trūkstamas, perteklinis ar per didelis laukas atmetamas (400/413) | `backupRoutes.route` | — |
| Aktyvūs darbai blokuoja atkūrimą (**409**), be turinio | `backupRoutes.route` | — |
| **Priežiūros užraktas uždaro TOCTOU langą** | `backupRoutes.route` | Užrakto pašalinimas |
| Užraktas nuimamas net operacijai nepavykus | `backupRoutes.route` | — |
| Užraktas turi maksimalią trukmę | `backupRoutes.route` | — |
| Pilnas ciklas per tikrus endpoint'us | `backupRoutes.route` | — |

### #20 PR5 — runbook kaip tikrinamas pažadas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Kopijuojamų artefaktų sąrašas sutampa su **politika** | `backupDocumentation` | Tipo pridėjimas be dokumentavimo |
| Numatytosios reikšmės sutampa su **kodu** | `backupDocumentation` | Retencijos pakeitimas dokumente |
| Paslapčių skaičius sutampa su **inventoriumi** | `backupDocumentation` | Paslapties pridėjimas → krinta |
| **Visi** grandinės žingsniai dokumentuoti | `backupDocumentation` | — |
| **Visi** maršrutų atsakymų kodai dokumentuoti | `backupDocumentation` | — |
| **Kiekviena** žinoma riba įvardyta | `backupDocumentation` | — |
| Įspėjimas apie dvigubą rotaciją išskirtas | `backupDocumentation` | Įspėjimo pašalinimas |
| Įvardyta, kad atkūrimas negrąžina ištrintų duomenų | `backupDocumentation` | — |

Runbook: [`docs/backup-runbook.md`](backup-runbook.md).

⚠️ **Runbook yra pažadas operatoriui.** Pasenęs jis blogesnis nei jokio: žmogus
nelaimės metu vykdys žingsnius, kurie nebeveikia, ir sužinos apie tai
blogiausiu momentu. Todėl jis tikrinamas CI.

⚠️ **`authenticate` defektas, rastas rašant PR4:** tikrinamas buvo tik `API_KEY`,
tad sistema su sukonfigūruotais `AUTH_USERS`, bet be rakto, dev režime likdavo
**atvira** — anoniminė užklausa gaudavo `administrator` teises. Ištaisyta.

 HTTP maršrutų kopijoms nėra;
leidimai užregistruoti iš anksto. Testas tikrina **lentelę**, ne operaciją —
atsiradus maršrutui jis kris ir privers pakeisti jį integraciniu.

⚠️ **Paslapčių patikros ribos.** Ji aptinka **šiuo metu sukonfigūruotų**,
inventoriuje esančių ir bent 8 simbolių paslapčių **tikslias reikšmes**. Ji
neaptiks jau rotuoto rakto, paslapties iš kitos aplinkos ar nesukonfigūruoto
tiekėjo rakto. Tai *best-effort* patikra, ne įrodymas, kad kopijoje paslapčių
nėra.

⚠️ **Auditas nekopijuojamas.** #19 ištrynimas šalina audito įrašus, o žymų
apsauga dengia jobus pagal ID – audito įrašai saugo pseudonimizuotą subjektą,
tad ta patikra jų neapima. Atkūrus auditą, GDPR ištrinti įrašai grįžtų.
**Pasekmė:** po atkūrimo audito žurnale nebus įrašų apie tai, kas vyko iki
kopijos – atkūrimas atstato duomenis, ne jų istoriją.

⚠️ **Pritaikymas nėra transakcinis.** Patikros pašalina priežastis, dėl kurių
atkūrimas nutrūktų, bet infrastruktūros gedimo (procesas nukrenta rašant) jos
neapima.

⚠️ **Šis etapas nieko nekopijuoja.** Politika, manifestas ir suderinamumo
patikros yra pagrindas kopijavimui ir atkūrimui, kurie ateina atskirai.

⚠️ **`BACKUP_RETENTION_DAYS` apibrėžia faktinį ištrynimo langą** (#19): gyvoje
sistemoje ištrinti duomenys kopijoje lieka iki jos galiojimo pabaigos.

## #21 — incidentų valdymas (PR1: karkasas)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Dokumentas ten, kur reikalauja DoD | `incidentRunbook` | — |
| **Komandose** naudojami kintamieji realiai egzistuoja | `incidentRunbook` | Komandos sugadinimas → krinta |
| **`API_KEY_ROLE=operator` NESUSTABDO įkėlimų** – ir taip pasakyta | `incidentRunbook` | Klaidingos instrukcijos grąžinimas → krinta |
| Įkėlimų jungiklio nėra – riba pripažinta | `incidentRunbook` | — |
| SIGTERM apdorojimo **buvimas/nebuvimas** atitinka dokumentą | `incidentRunbook` | — |
| Bash komandose **nėra shell placeholder'ių** | `incidentRunbook` | `<vardas>` grąžinimas → krinta |
| Eilės konfigūracija **nepateikiama kaip besąlyginė** | `incidentRunbook` | Kategoriškos garantijos grąžinimas |
| **503 atsiranda TIK pašalinus abu** mechanizmus (401 — kitais atvejais) | `incidentRunbook` | — |
| Startup validacija neblokuoja produkcijos be abiejų | `incidentRunbook` | — |
| Minimi audito įvykiai egzistuoja kode | `incidentRunbook` | Neegzistuojantis įvykis → krinta |
| Minimi endpoint'ai **realiai atsako** (HTTP, ne teksto paieška) | `incidentRunbook` | Neegzistuojantis kelias → krinta |
| Nurodoma, **kur** rasti aktualų paslapčių sąrašą | `incidentRunbook` | — |
| Įvardytas skirtumas tarp vidinių ir **išorinių** paslapčių | `incidentRunbook` | — |
| Visi keturi skubumo lygiai su **terminais** | `incidentRunbook` | — |
| Eigos žingsniai **ta pačia tvarka** | `incidentRunbook` | — |
| GDPR pranešimas **nepateikiamas kaip automatinis** | `incidentRunbook` | — |
| Sprendimą priima **duomenų valdytojas** (BDAR 33 str.) | `incidentRunbook` | — |
| Sulaikymo veiksmai **nenaikina įrodymų**; negrįžtamos išimtys dokumentuotos | `incidentRunbook` | — |
| Dokumente **nėra tikrų paslapčių** | `incidentRunbook` | — |

Runbook: [`docs/operations/INCIDENT_RESPONSE.md`](operations/INCIDENT_RESPONSE.md).

### #21 PR2 — operacinės procedūros

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Auditas tikrai neišgyvena restarto** – ir taip pasakyta | `operationalProcedures` | Rašymo į diską pridėjimas → krinta |
| Minimi endpoint'ai realiai atsako | `operationalProcedures` | — |
| Minimi audito įvykiai egzistuoja kode | `operationalProcedures` | Neegzistuojantis įvykis → krinta |
| `/api/audit` parametrai atitinka realią schemą | `operationalProcedures` | — |
| Pseudonimizacijos įspėjimas atitinka realų lauką | `operationalProcedures` | — |
| Audito retencija sutampa su `.env.example` | `operationalProcedures` | Reikšmės pakeitimas → krinta |
| `ENOENT` ištrynime **tikrai** reiškia sėkmę | `operationalProcedures` | — |
| Atkūrimo patikra turi visus šešis žingsnius **ta tvarka** | `operationalProcedures` | — |
| Įvardyta, kad `mock` duoda sintetinius rezultatus | `operationalProcedures` | — |
| Bash komandose nėra shell placeholder'ių | `operationalProcedures` | — |
| Dokumente nėra paslapčių; raginama nekopijuoti `.env` | `operationalProcedures` | — |
| **`--since` apribojimas įvardytas**, ne nutylėtas | `operationalProcedures` | Tylaus `--since` grąžinimas → krinta |
| Baigiamoji taisyklė draudžia dalinį uždarymą | `operationalProcedures` | Taisyklės pašalinimas → krinta |
| Įvardyta, kokiai aplinkai skirtos komandos | `operationalProcedures` | — |
| **`.env` būsena skaitoma iš FAILO**, ne shell aplinkos | `operationalProcedures` | `printenv` grąžinimas → krinta |
| `curl` **neišsaugo klaidos atsakymo** kaip įrodymo | `operationalProcedures` | `--fail-with-body` pašalinimas → krinta |
| Dokumentas neteigia, kad shell komandos tikrinamos CI | `operationalProcedures` | — |
| Draudimas liečia **restartą**, ne bet kokį sulaikymą | `operationalProcedures` | — |

Procedūros: [`docs/operations/OPERATIONAL_PROCEDURES.md`](operations/OPERATIONAL_PROCEDURES.md).

### #21 PR3 — peržiūra, pratybos ir apimtis

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Kiekviena nuoroda į skyrių realiai egzistuoja** | `postmortemTemplate` | Neegzistuojantis §; pernumeravimas kitame dokumente |
| Nuorodos veda į visus tris dokumentus | `postmortemTemplate` | — |
| Šablonas turi visus privalomus skyrius | `postmortemTemplate` | — |
| Laiko juosta apima „įrodymai išsaugoti" | `postmortemTemplate` | — |
| Šablonas draudžia turinį, vardus ir raktus | `postmortemTemplate` | — |
| Veiksmas be atsakingo įvardytas kaip netinkamas | `postmortemTemplate` | — |
| Neišbandytas runbook **nėra procedūra** | `postmortemTemplate` | — |
| Pratybų rezultatas — **ne „pavyko"** | `postmortemTemplate` | — |
| **Visos aštuonios ribos** įvardytos santraukoje | `postmortemTemplate` | Ribos pašalinimas → krinta |
| Ribos su šaltiniu tikrinamos **skyriuje**, eksplicitiniu šablonu | `postmortemTemplate` | Ribos pašalinimas iš **šaltinio** → krinta |
| Ribos be šaltinio privalo turėti **priežastį** | `postmortemTemplate` | — |
| Audito trumpalaikiškumas — **svarbiausia** riba | `postmortemTemplate` | — |
| **Auditas NĖRA pateikiamas kaip absoliučiai pirmas** žingsnis | `postmortemTemplate` | Absoliučios taisyklės grąžinimas → krinta |
| Prieigos pratyboms reikalaujamas `NODE_ENV=production` | `postmortemTemplate` | Sąlygos pašalinimas iš eilutės → krinta |
| Rakto atšaukimo pratyboms — **testinis** kredencialas | `postmortemTemplate` | — |
| „Out of scope" atitinka issue | `postmortemTemplate` | — |

Peržiūra ir pratybos:
[`docs/operations/POSTMORTEM_AND_EXERCISES.md`](operations/POSTMORTEM_AND_EXERCISES.md).

⚠️ **Apimties lentelė sensta greičiausiai iš visko:** pakanka pervadinti skyrių
kitame dokumente, ir nuoroda tampa melu. Todėl kiekviena `§` nuoroda tikrinama
prieš tikslinį failą — ir būtent ši patikra aptiko, kad #120 buvo sumergintas
be patvirtintų pataisymų.

⚠️ **Auditas gyvena tik atmintyje.** Todėl jo išsaugojimas yra **pirmas**
incidento žingsnis — anksčiau nei sulaikymo veiksmai, kurie reikalauja restarto.

⚠️ **Incidentų runbook skaitomas blogiausiu momentu:** skubant, su nepilna
informacija, dažnai ne to žmogaus, kuris jį rašė. Neteisingas kintamasis ar
neveikianti komanda sukelia abejonę **visu dokumentu** būtent tada, kai juo
reikia pasitikėti. Todėl jis tikrinamas CI.

## #22.1 — tiekėjų inventorius ir valdysena

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Kiekvienas matricos tiekėjas turi valdysenos įrašą** | `providerGovernance` | — |
| Valdysenoje nėra tiekėjų, kurių nėra matricoje | `providerGovernance` | — |
| **Nežinoma savybė niekada nereiškia patvirtinimo** | `providerGovernance` | Patvirtinimo panaikinimas → krinta 2 |
| Nė vienas **išorinis** tiekėjas nepažymėtas `verified` | `providerGovernance` | `verified` pažymėjimas → krinta |
| Nežinomas tiekėjas ir tipas **neleidžiami** | `providerGovernance` | Leidimo suteikimas → krinta 2 |
| Išorinis leidžiamas tik su `APPROVED_EXTERNAL_PROVIDERS` | `providerGovernance` | — |
| Diagnostika rodo politiką **be paslapčių** | `providerGovernance` | — |
| Kiekvienas tiekėjas paminėtas dokumente | `providerGovernance` | — |
| Įvardyta, kad **techninė kontrolė ≠ teisinė atitiktis** | `providerGovernance` | — |
| Sąrašas **įgyvendina** sprendimą, bet jo **neįrodo** | `providerGovernance` | Klaidinančios formuluotės grąžinimas → krinta |
| `unknown` įvardytas kaip „nepatikrinta", ne „nesaugu" | `providerGovernance` | — |
| Patvirtintų tiekėjų sąrašas dedublikuojamas | `providerGovernance` | Dedublikavimo pašalinimas → krinta |
| `assumed` nenaudojamas, bet jo paskirtis dokumentuota | `providerGovernance` | — |

### #22.2 — politikos vykdymas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Nepatvirtintas tiekėjas blokuojamas **visuose trijuose fabrikuose** | `providerEnforcement` | Patikros pašalinimas → krinta 5 |
| Patvirtintas praeina — apsauga **nėra aklas blokas** | `providerEnforcement` | — |
| Lokalūs veikia be patvirtinimo | `providerEnforcement` | — |
| Patvirtinimas galioja **per tiekėją**, ne kategoriją | `providerEnforcement` | — |
| **Užklausos override neapeina** valdysenos | `providerEnforcement` | — |
| Neleistinas tiekėjas **stabdo paleidimą** | `providerEnforcement` | Startup patikros išjungimas → krinta 2 |
| Tikrinami **visi trys** tiekėjų kintamieji | `providerEnforcement` | — |
| Rašybos klaida duoda „nežinomas tiekėjas", ne valdysenos klaidą | `providerEnforcement` | Tvarkos sukeitimas → krinta 2 |
| Visi fabrikai kviečia **tą pačią** patikrą | `providerEnforcement` | — |
| Testinio tiekėjo registracija veikia tik `NODE_ENV=test` | `providerEnforcement` | — |
| Fabrikai naudoja **vieną bendrą** patikrą, ne kopijas | `providerEnforcement` | Kopijos grąžinimas → krinta |
| Startup ir fabrikai naudoja **tą patį parserį** | `providerEnforcement` | Savo parserio grąžinimas → krinta |
| **Dublikatai rinkiniuose stabdo paleidimą** | `providerEnforcement` | Dublikato grąžinimas → paleidiklis krinta |

### #22.3 — apsauga nuo apėjimo

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Maršrutai, worker'iai ir eilės **neimportuoja tiekėjų tiesiogiai** | `providerBypassGuards` | Tiesioginis importas → krinta 2 |
| Fabrikai — **vienintelis kelias** į provider klases | `providerBypassGuards` | Ta pati |
| Servisai kviečia fabrikus, **ne konstruktorius** | `providerBypassGuards` | `new XProvider()` → krinta |
| Matrica, valdysena ir dokumentas **nesiskiria** | `providerBypassGuards` | Tiekėjo pašalinimas → krinta 3 |
| **Kiekvienas `REGISTRY` tiekėjas** turi politiką | `providerBypassGuards` | Ta pati |
| Diagnostika sutampa su **realiu** sprendimu | `providerBypassGuards` | — |
| Nė vienam tiekėjui negrąžinamos paslaptys | `providerBypassGuards` | — |
| README ir `.env.example` nesiskiria nuo kodo | `providerBypassGuards` | — |

⚠️ **Skirtumas nuo #22.2:** tie testai tikrina, kad patikra **veikia**. Šie —
kad nėra **kelio**, kuriuo ją būtų galima aplenkti. Elgsenos testas naujo
apėjimo kelio nepagautų: jis tikrina esamus kelius, ne būsimus.

⚠️ **Patikra dedama FABRIKE, ne maršrute** — tai vienintelis kelias, kuriuo
tiekėjas atsiranda. Todėl ji automatiškai galioja HTTP maršrutams, inline
vykdymui ir BullMQ worker'iams (ta pati logika kaip #19 žymų patikra
`jobStore.update` viduje).

Inventorius ir kontrolinis sąrašas:
[`docs/provider-governance.md`](provider-governance.md).

⚠️ **Visos išorinių tiekėjų savybės pažymėtos `unknown`** — tai ne spraga, o
tiksli šio projekto būklė. Įrašyti `verified` be realaus patikrinimo reikštų
teigti neverifikuotas sutartines garantijas.

⚠️ **`APPROVED_EXTERNAL_PROVIDERS` nėra atitikties įrodymas.** Kodas negali
atskirti apgalvoto sprendimo nuo neatsargaus `.env` pakeitimo — sąrašas
sprendimą tik įgyvendina.

⚠️ Šis etapas apibrėžia **politiką**; jos vykdymas — #22.2, apsauga nuo
regreso — #22.3.

## #23.1 — vertinimo karkasas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Lietuviški diakritikai išlaikomi** | `qualityMetrics` | Šalinimas → krinta 2 |
| Skaitmenys nekeičiami į žodžius | `qualityMetrics` | — |
| WER skaidomas į S/I/D (gedimų analizei) | `qualityMetrics` | — |
| **WER gali viršyti 100%** – neapkerpamas | `qualityMetrics` | Apkirpimas → krinta |
| Tuščias referencinis duoda `null`, ne 0 | `qualityMetrics` | — |
| CER atskiria linksniavimą nuo nesuprasto žodžio | `qualityMetrics` | — |
| Kalbėtojų vardų skirtumas nebaudžiamas | `qualityMetrics` | — |
| Metrika **nevadinama standartiniu DER** | `qualityMetrics` | — |
| **Prarasti segmentai negali duoti 100%** | `qualityMetrics` | Vardiklio pakeitimas į `min` → krinta 2 |
| Pertekliniai segmentai irgi mažina tikslumą | `qualityMetrics` | — |
| Kalbėtojų susiejimas **optimalus**, ne godus | `qualityMetrics` | — |
| Tipografinė skyryba nekuria klaidų | `qualityMetrics` | — |
| Brūkšnelis ir apostrofas **žodyje** paliekami | `qualityMetrics` | — |
| **Turinio laukai manifeste neleidžiami** (allowlist) | `qualityMetrics` | Draudimo pašalinimas → krinta |
| `split` privalomas ir ribotas | `qualityMetrics` | — |
| Laukų tipai ir ribos tikrinami | `qualityMetrics` | — |
| Atspaudas apima `origin` ir `split` | `qualityMetrics` | Laukų pašalinimas → krinta |
| Manifesto **kilmė privaloma** ir ribota | `qualityMetrics` | Patikros išjungimas → krinta |
| Aprėpties spragos įvardijamos, bet nestabdo | `qualityMetrics` | — |
| Atspaudas nepriklauso nuo įrašų tvarkos | `qualityMetrics` | — |
| **Manifeste nėra nei garso, nei transkripcijų** | `qualityMetrics` | — |
| Protokolo taisyklės **sutampa su kodu** | `qualityMetrics` | — |

Protokolas: [`docs/evaluation-protocol.md`](evaluation-protocol.md).

⚠️ **Protokolas rašomas PRIEŠ matavimą.** Apibrėžus metodiką po to, kai
rezultatai matomi, ji neišvengiamai pasirenkama taip, kad rezultatai atrodytų
geriau — net be blogos valios.

⚠️ Šis etapas nieko **nevertina** — jis paruošia matavimo priemones. Rezultatai
yra #23.2, sprendimas dėl piloto — #23.3.

## #28 PR1 — piloto charta

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Tiekėjų skaičiai sutampa su **realiu inventoriumi** | `pilotCharter` | Skaičiaus pakeitimas → krinta |
| Minimi **tik egzistuojantys** privatumo profiliai | `pilotCharter` | `ephemeral` → krinta |
| Minimi kintamieji egzistuoja `.env.example` | `pilotCharter` | — |
| **Visos žinomos ribos** įvardytos IR patvirtintos šaltiniuose | `pilotCharter` | Ribos pašalinimas → krinta |
| Nuorodos į issue realiai egzistuoja | `pilotCharter` | — |
| Hipotezės **paneigiamos** ir turi tikrinimo būdą | `pilotCharter` | — |
| Transkribavimo ir protokolo kokybė **atskirtos** | `pilotCharter` | — |
| Ypatingų kategorijų draudimas su **teisiniu pagrindu** | `pilotCharter` | — |
| Redakcija įvardyta kaip **apsauga, ne leidimas** | `pilotCharter` | — |
| Apimties keitimas reikalauja **įrašo** | `pilotCharter` | — |
| Kiekviena prielaida turi **pasekmę** | `pilotCharter` | — |
| Pilotas **nėra automatinis perėjimas** į produkciją | `pilotCharter` | — |
| **Įgyvendinta metodika atskirta nuo planuojamos** (#23 vs #24) | `pilotCharter` | #24 kaip esamas → krinta |
| Sargybinis: atsiradus #24, charta privalės būti atnaujinta | `pilotCharter` | — |
| H2 matuojamas **tas pats žmogus** | `pilotCharter` | — |
| Valdysena **įgyvendina, bet neįrodo** organizacinio sprendimo | `pilotCharter` | Ribos pašalinimas → krinta |
| Biometriniai identifikatoriai įvardyti atskirai | `pilotCharter` | — |
| **Skubūs saugumo pakeitimai** nėra apimties pakeitimas | `pilotCharter` | Išimties pašalinimas → krinta |
| Organizacijų sąrašui galioja ta pati keitimo tvarka | `pilotCharter` | — |

Charta: [`docs/pilot/PILOT_CHARTER.md`](pilot/PILOT_CHARTER.md).

⚠️ **Charta yra pažadas organizacijai**, ne techninė dokumentacija. Jos
senėjimas pavojingesnis: ja remiamasi priimant sprendimus apie asmens duomenis.

⚠️ Ribų sąrašas tikrinamas **abiem kryptimis** — kiekviena riba turi būti ir
chartoje, ir pirminiame dokumente. Kitaip santrauka teigtų tai, ko šaltinis
nesako.

## #24.1 — protokolo vertinimo rubrika

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Svoriai **netiesiniai** – kosmetinės nekompensuoja kritinių | `protocolRubric` | Tiesiniai svoriai → krinta |
| **Kritinė klaida yra VETO** | `protocolRubric` | Veto pašalinimas → krinta |
| Nežinomas sunkumas **metamas**, ne ignoruojamas | `protocolRubric` | — |
| **Radinyje negali būti citatų** ar turinio | `protocolRubric` | Draudimo pašalinimas → krinta |
| Nuoroda yra **pozicija, ne tekstas** | `protocolRubric` | — |
| Nutarimai ir užduotys **reikalauja** nuorodos | `protocolRubric` | — |
| Santrauka nuorodos nereikalauja | `protocolRubric` | — |
| **Nepagrįstas teiginys yra gedimas** | `protocolRubric` | Patikros išjungimas → krinta 2 |
| Modelio išvada **privalo būti pažymėta** | `protocolRubric` | — |
| **Kilmės taisyklė duoda vienareikšmį atsakymą** | `protocolRubric` | — |
| **Išvada irgi privalo turėti nuorodą** | `protocolRubric` | Reikalavimo susiaurinimas → krinta |
| Nesutarus imamas **griežtesnis** sunkumas | `protocolRubric` | `Math.min` → krinta |
| Nesutarus imama **konservatyvesnė** kilmė | `protocolRubric` | — |
| Sutarimo dalis — **metodikos**, ne kokybės matas | `protocolRubric` | — |
| Galutiniam rinkiniui **du vertintojai** | `protocolRubric` | — |
| Atsekamumo dalis **nėra kokybės matas** | `protocolRubric` | — |
| Balo negalima lyginti tarp skirtingo ilgio protokolų | `protocolRubric` | — |
| Veto taikomas **pirmiau** nei balų riba | `protocolRubric` | — |
| Fiksuojama konkreti **modelio versija** | `protocolRubric` | — |
| Laukai realiai egzistuoja `meeting_v3` protokole | `protocolRubric` | — |
| Svoriai ir laukai dokumente **sutampa su kodu** | `protocolRubric` | — |
| **Determinizmo riba** įvardyta (LLM ≠ faster-whisper) | `protocolRubric` | — |
| Rubrika **nepakeičia** žmogaus peržiūros | `protocolRubric` | — |

Metodika: [`docs/protocol-evaluation-rubric.md`](protocol-evaluation-rubric.md).

⚠️ **Protokolas nėra transkripcija.** Sistema gali turėti nepriekaištingą WER
(#23) ir vis tiek generuoti protokolą su išgalvotu nutarimu.

⚠️ Vertina **žmogus, bet pagal iš anksto apibrėžtus kriterijus**: „man atrodo
neblogai" nėra vertinimas, o automatinė metrika neaptiktų prasmės iškraipymo.

## #159 — job nuosavybė (`ownerId` + `ownerKind`)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| A negauna, nekeičia ir neištrina B job'o | `jobOwnership` | `matchesOwner` rūšies patikros pašalinimas → krinta 4 |
| Svetimas job'as neatskleidžiamas per HTTP (nei 200, nei turinys) | `rbac.route` | `denyIfForbidden` pašalinimas → krinta HTTP testas |
| Svetimo job'o DELETE nepalieka šalutinio poveikio | `rbac.route` | Tikrinamas ne tik statusas, bet ir kad įrašas liko store'e |
| `FORBIDDEN` ≠ `null` (403/404 sprendimas lieka #160) | `jobOwnership` | `Symbol` truthy: `if (!job)` jo nepagauna |
| Bendras `API_KEY` NĖRA legacy job'o savininkas | `jobOwnership` | Be `ownerKind` abu normalizuojasi į `""` → savininkas |
| `""` NĖRA wildcard (trys `null` deriniai) | `jobOwnership`, `ownershipCasRedis.integration` | Rūšies patikros pašalinimas |
| Legacy įrašas nepriklauso NĖ VIENAI vartotojo rūšiai | `jobOwnership` | Fixture per `restoreRecord()`, ne `create()` |
| `ownerId`/`ownerKind` nekeičiami per `applyPatch` | `jobOwnership` | Immutability pašalinimas → krinta 1 |
| `create()` nepriima legacy formato ir prieštaringų derinių | `jobOwnership` | `assertCreateOwnership` pašalinimas → krinta 2 |
| Tas pats invariantas kūrimui IR skaitymui | `jobOwnership` | Derinio patikros pašalinimas → krinta visas failas |
| Pozicinis `id` atmetamas (scope privalomas) | `jobOwnership` | `assertScope` pašalinimas → krinta 1 |
| Nuosavybės patikra ir rašymas **atominiai** | `ownershipCasRedis.integration` | Lua CAS pašalinimas → krinta race testas |
| CAS tikrina IR rūšį, ne tik `ownerId` | `ownershipCasRedis.integration` | Lua `kind` patikros pašalinimas → krinta 1 |
| Sisteminis sweep mato VISŲ savininkų job'us | `jobOwnership`, `ownershipCasRedis.integration` | Aklas scope'inimas nutildytų retenciją |
| `jobStore.system` nepasiekiamas iš `routes/` | `systemNamespaceBoundary` | `jobStore.system.get()` įvedimas maršrute → krinta |
| Dev-open ≠ bendras `API_KEY` | `exports.route`, `transcribeJobs.route` | `API_KEY` patikros pašalinimas → krinta 10 |

⚠️ **Atomiškumo riba (sąmoninga).** Atominė yra TIK nuosavybės savybė: `HSET`
neįvyksta, jei savininkas ar rūšis pasikeitė. Patch'as skaičiuojamas iš galimai
pasenusio įrašo — tai esama last-write-wins semantika, kurios #159 nekeičia.

⚠️ **Race testai turi eiti per Lua, ne per JS greitąjį kelią.** Pirmoji CAS testo
versija keitė savininką PRIEŠ `updateOwned()`, tad suveikdavo JS pusės
`matchesOwner()` ir mutacija liko nepagauta. Dabar rūšis/ID keičiami
interceptinant pirmą `eval()`.

⚠️ **Našlaičių nuosavybė NETIKRINAMA.** `eraseOrphanedJobData()` veikia tada, kai
`jobStore` įrašo nebėra — kartu nebėra ir `ownerId`. Rezultatas žymimas
`ownershipVerified: false`; politika (eilinis vartotojas ar admin-only) — #160.

---

## #160 — prieigos politika (403/404, admin override)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Bendras `API_KEY` NEGAUNA admin override, net su `administrator` role | `jobAccessPolicy` | `API_KEY_ROLE` numatytoji reikšmė YRA `administrator` — patikra vien pagal rolę atidarytų override pagal nutylėjimą |
| Desktop principalas negauna override | `jobAccessPolicy` | `ownerKind` patikros pašalinimas |
| Eilinis vartotojas NIEKADA negauna 403 (nėra egzistavimo orakulo) | `jobAccessPolicy` | Bet kuris `DENIED` ne-admin ląstelėje |
| Admin NEGALI skaityti svetimo job'o (override tik `DELETE`) | `jobAccessPolicy` | `operation` patikros pašalinimas → `READ` gautų override |
| `FORBIDDEN` ir `MISSING` duoda skirtingus sprendimus | `jobAccessPolicy` | Šakų sujungimas → legacy patektų į našlaičių valymą |
| Našlaičių valymas admin-only | `jobAccessPolicy` | Ne-admin šakos pašalinimas |
| Politika yra gryna funkcija (jokio šalutinio poveikio) | `jobAccessPolicy` | `actor` objekto mutacija; determinizmo patikra |
| Nežinomas `input`/`operation` meta klaidą, ne tylų `NOT_FOUND` | `jobAccessPolicy` | Tylus fallback paslėptų kodo klaidą |

### Administracinis override (`services/adminJobService.js`)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Servisas PATS tikrina session-admin, nepasitiki maršrutu | `adminJobService` | `assertSessionAdmin` pašalinimas → API-key admin ištrintų svetimą job'ą |
| Atmesti bandymai nieko neištrina | `adminJobService` | Tikrinamas įrašas store'e, ne tik metama klaida |
| Job'as dingęs tarp sprendimo ir trynimo → **fail-closed** | `adminJobService` | Tylus perėjimas į našlaičių valymą pakeistų operaciją be pėdsako |
| Override turi SAVO audito įvykį | `adminJobService` | `ADMIN_DELETE_OVERRIDE` ≠ įprastas savininko trynimas |
| **Nepavykęs** bandymas irgi audituojamas | `adminJobService` | Be to analizė matytų tik sėkmingus override'us |
| Audite nėra job turinio nei neapdoroto ID | `adminJobService` | Tikrinamas serializuotas visas audito srautas |
| Privilegijuotas kelias sutelktas VIENAME servise | `systemNamespaceBoundary` | Allowlist su pagrindimu; `routes/` išimčių neturi |
| **Sėkmė išvedama iš rezultato, ne iš Promise** | `adminJobService` | `success: true` besąlygiškai → krinta: kritinė nesėkmė atrodytų kaip sėkmingas override |
| Naudojamas TAS PATS sėkmės kriterijus kaip savininko kelyje | `adminJobService` | `lifecycleService.deleteJobArtefacts`, ne tiesioginis `eraseJob()` |

### Transporto sluoksnis (`utils/jobAccessTransport.js`)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Eilinis vartotojas svetimam `GET` gauna 404, ne turinį | `rbac.route` | `respondToDenial` pašalinimas |
| Session-admin svetimam `GET` gauna 403 BE turinio | `rbac.route` | `ADMIN_READ_NOT_ALLOWED` kodas; turinio laukai tikrinami |
| Session-admin svetimą job'ą ištrina (override) | `rbac.route` | Du administratoriai – nuosavybė izoliuota nuo rolės |
| Eilinis vartotojas NEVALO našlaičio | `rbac.route` | Elgesio pakeitimas: anksčiau valė bet kas |
| Maršrutai NEsprendžia 403/404 patys | `systemNamespaceBoundary` | `jobStore.FORBIDDEN` maršrute → sargas krinta |
| Nuosavybės kelyje nėra `apiKey`/`API_KEY` identifikatorių | `systemNamespaceBoundary` | Tikrinamos ABI formos: kintamasis IR konstantos savybė. `storageKey` ir `env.API_KEY` praeina |
| **EXPORT: svetimas ir neegzistuojantis job'as NEATSKIRIAMI** | `rbac.route` | Politikos apėjimas → `link=job`/`invalid_type` atskleistų egzistavimą |
| EXPORT: admin svetimo job'o nesusieja (skaitymo override neleidžiamas) | `rbac.route` | Tikrinamas audito `link=`, ne statusas |
| EXPORT: savininkas savo job'ą susieja (regresija) | `rbac.route` | `invalid_type` įrodo, kad savas job'as PASIEKIAMAS |
| Adapteris atsako TIK už neigiamus sprendimus | `jobAccessTransport` | Teigiami sprendimai nekeičia `res` |
| Aktorius neša rūšį IR rolę | `jobAccessTransport` | Vien rolė → bendras raktas gautų override |
| Desktop režimas: našlaičių valymas leidžiamas | `jobAccessPolicy`, `deletionResilience` | Admin-only politika desktop diegime jį padarytų neįmanomą |
| Desktop išimtis NEGALIOJA bendram raktui | `jobAccessPolicy` | Abu turi `ownerId: null`; skiria tik rūšis |

⚠️ **CodeQL `js/clear-text-logging` klaidingi signalai.** Ši taisyklė laiko `*key*`
identifikatorius jautriais ir pažymi bet kokį jų kelią į logerį. Nuosavybės objektai
paslapčių neturi (loginami tik `ownerId`, `ownerKind`, `operation`), bet CI krito tris
kartus: `apiKeyScope` (#159), `apiKeyAdmin` (#160) ir `OWNER_KIND.API_KEY` (#160).
**Trečiuoju atveju kintamųjų pervadinimas nepadėjo — tikrasis šaltinis buvo KONSTANTOS
savybė.** Todėl sargas tikrina abi formas. Konstanta pervadinta į `API_PRINCIPAL`, o jos
reikšmė (`"api-key"`) palikta: ji saugoma Redis'e, tad keitimas būtų duomenų migracija.

⚠️ **EXPORT transporto semantika SKIRIASI nuo `GET`.** Eksportas nenaudoja
`respondToDenial()`: `DENIED` ir `NOT_FOUND` abu virsta `linkState = "missing"`, o pats
eksportas tęsiasi (protokolas ateina užklausos kūne). Todėl `GET` testai eksporto
elgesio NEĮRODO ir jam reikia atskirų HTTP testų — jie tikrina audito `link=` reikšmę,
ne HTTP statusą.

⚠️ **Desktop išimtis.** Našlaičių valymas vieno vartotojo režime NĖRA override:
grėsmės modelis („kitas vartotojas žino tavo job ID") ten negalioja. Todėl jis neturi
atskiro `ADMIN_*` audito įvykio — privilegija nepanaudota, o patį ištrynimą dokumentuoja
`DATA_ERASED` kvitas. Antras įrašas iškreiptų override statistiką.

⚠️ **Politika atskirta nuo vykdymo.** `decideJobAccess()` grąžina sprendimą; store'o
kvietimai, trynimas ir auditas lieka servise. Kitaip „HTTP mapping helperis" virstų
authorization + deletion orchestration moduliu, o lenktynes taptų sunku testuoti izoliuotai.

---

## #153 — rezultatų ir artefaktų dydžio ribos (apsauga IŠĖJIME)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Dydis matuojamas UTF-8 baitais, ne simboliais | `resultLimits` | `.length` duotų dvigubai laisvesnę ribą lietuviškam tekstui |
| **`MAX_STREAM_BUFFER_BYTES` = RAM apsauga (SSE parse buferis)** | `fasterWhisperStream` | Testas siunčia NEUŽBAIGTĄ įvykį; patikros pašalinimas → „UŽSTRIGO", ne kabo |
| `MAX_STREAM_TOTAL_BYTES` = transporto kvota, NE RAM | `fasterWhisperStream` | Pilni įvykiai buferio neaugina – testas tai ir įrodo |
| Turinio ribos veikia IR be streaming (`WHISPER_STREAM_PROGRESS=false`) | `fasterWhisperStream` | Patikra iškelta į vieną viešą įėjimą; anksčiau numatytoje konfigūracijoje neveikė visai |
| Diarizacijos riba tikrinama per TIKRĄ providerį | `resultLimits` | `assertWithinLimit` pašalinimas providerio viduje → krinta |
| Env reikšmė validuojama VISA, ne prefiksu | `resultLimits` | `"20MB"` → 20 baitų riba tyliai sustabdytų sistemą |
| Ribos viršijimas turi domeninį `kind`, ne transporto exception | `resultLimits` | Klasifikatoriaus šakos pašalinimas → `internal_error` |
| Domeninė klaida NEapvyniojama providerio fallback sluoksnyje | `fasterWhisperStream` | Apvyniojus → `kind` prarandamas, job'as gauna `internal_error` |
| Viršijus ribą job'as pereina į **terminalų** `failed` | `resultLimits` | Blogiausias variantas – pakibęs `processing` |
| Job metaduomenys LIEKA, rezultato artefaktas – ne | `resultLimits` | Tikrinamos abi pusės |
| `MAX_RESULT_BYTES` matuoja TIK `result`, ne job metaduomenis | `resultLimits` | Kitaip riba priklausytų nuo laiko žymų ir audito laukų |
| Patikra ABIEJUOSE vykdymo keliuose (inline + BullMQ) | `resultLimits` (statinis sargas) + **`resultLimitsWorker.integration` (tikras Redis)** | Statinis sargas praeitų ir su `if (false)`; integracinis testas tikrina ELGESĮ produkcijos kelyje |
| **Ribos viršijimas NEATKARTOJAMAS** (`UnrecoverableError`) | `resultLimitsWorker.integration` | Be jo BullMQ kartotų `attempts` kartus — kiekvienas bandymas = pilnas transkribavimas ar LLM kvietimas iš naujo |
| Neatkartojama klaida yra GALUTINĖ iš karto | `resultLimitsWorker.integration` | `attemptsMade >= attempts` vieno nepakanka: job'as liktų amžinai `processing` |
| `result` NEĮRAŠOMAS į store net su tikru Redis | `resultLimitsWorker.integration` | Patikra po `update` → per didelis rezultatas jau gulėtų DB (po #155) |
| Skaitikliai matuoja BAITUS, ne `length` | `resultLimits`, `fasterWhisperStream` | `chunk.byteLength`, ne `chunk.length` — viešas env kontraktas deklaruoja baitus |
| Tekstas ir JSON matuojami atskirais helperiais | `resultLimits` | `"abc"` = 3 baitai kaip tekstas, 5 kaip JSON — vienas helperis supainiotų ribas |
| Netinkama env reikšmė grįžta prie numatytosios, ne prie `0` | `resultLimits` | `0` riba reikštų, kad viskas viršija – sistema sustotų |
| Numatytos reikšmės nepertraukia normalaus srauto | `fasterWhisperStream` | Regresija prieš per griežtus defaults |

### Ribų vykdymo momentai

| Riba | Momentas |
|---|---|
| `MAX_STREAM_BUFFER_BYTES` | inkrementinis — transporto RAM apsauga |
| `MAX_STREAM_TOTAL_BYTES` | inkrementinis — transporto kvota (ne RAM) |
| `MAX_SEGMENTS` | post-`done` |
| `MAX_TRANSCRIPT_BYTES` | post-payload |
| `MAX_RESULT_BYTES` | prieš rašymą į store |
| `MAX_DIARIZATION_TURNS` | post-response |

⚠️ **Dvi inkrementinės ribos matuoja SKIRTINGUS dalykus.** `MAX_STREAM_BUFFER_BYTES` –
SSE parse buferio dydis IŠKART po chunk'o pridėjimo, dar PRIEŠ pilnų įvykių išėmimą. Tad
matavimas sąmoningai konservatyvus: buferyje gali laikinai būti nebaigtas įvykis plius
pilni įvykiai iš to paties chunk'o. Tikrinti po išėmimo būtų grynesnė semantika, bet
silpnesnė apsauga — didelis chunk'as jau būtų sukauptas atmintyje. Tai ankstyviausias
įmanomas kontrolės taškas kliento pusėje.

⚠️ **`MAX_STREAM_BUFFER_BYTES` nėra peak-RAM hard cap.** Chunk'as jau gautas,
dekoduotas į JS string'ą ir prijungtas prie buferio, ir tik tada tikrinama. Riba neleidžia
parse buferiui augti TOLIAU, bet negarantuoja, kad proceso atmintis niekada neviršys ribos
dėl vieno patologinio chunk'o. Tai ankstyviausias kontrolės taškas **po gauto chunk'o
dekodavimo**, ne absoliučiai ankstyviausias.

⚠️ **Netinkama ribos konfigūracija fails safe į įmontuotą lubą** — ne į `0`/`Infinity`
(riba dingtų arba viskas viršytų) ir ne į startup klaidą (tipografinė klaida env faile
sustabdytų visą servisą). Sąmoningai pasirinktas prieinamumas su galiojančia luba.

⚠️ **ŽINOMA TESTŲ APRĖPTIES RIBA.** Testai įrodo, kad riba SUVEIKIA, bet ne kad ji
suveikia ankstyviausiu momentu. Perkėlus patikrą PO pilnų įvykių išėmimo visi testai
praeina — skirtumas matomas tik piko atminties matavimu, kurio patikimai testuoti
neįmanoma. Todėl patikros VIETA yra apsaugota tik kodo komentaru ir šia pastaba, ne testu.
Keičiant tą eilutę verta perskaityti pagrindimą `FasterWhisperProvider._transcribeStream`.

⚠️ Ši riba **NĖRA** transkripcijos dydžio riba ir **NEPADARO** `MAX_SEGMENTS` ar turinio
ribų inkrementinėmis. `MAX_STREAM_TOTAL_BYTES` –
kaupiami transporto baitai, kvota prieš begalinį srautą, bet **ne** RAM apsauga: pilni
įvykiai iš buferio pašalinami iškart, tad siunčiant normalius `progress` įvykius buferio
maksimumas yra 0 baitų. Visos turinio ribos
(`MAX_TRANSCRIPT_BYTES`, `MAX_SEGMENTS`, `MAX_DIARIZATION_TURNS`) yra **post-response**:
nei `/transcribe-stream`, nei `pyannote` HTTP kontraktas turinio inkrementiškai neatiduoda —
`whisper-server/server.py` kaupia segmentus serverio pusėje ir siunčia juos terminaliame
`done` įvykyje. Jos saugo downstream (store, protokolo generavimą), ne kliento RAM.
Serverio pusės inkrementinės ribos — atskiras darbas.

⚠️ **Transporto ribos ≠ turinio ribos.** SSE neša JSON envelope, įvykių metaduomenis ir
`progress` įvykius. Vienas env, ribojantis transportą po turinio pavadinimu, po metų būtų
interpretuotas neteisingai.

⚠️ **Turinio ribos nepriklauso nuo transporto režimo.** `MAX_TRANSCRIPT_BYTES` ir
`MAX_SEGMENTS` tikrinami viename viešame `transcribe()` įėjime, tad veikia ir su
`WHISPER_STREAM_PROGRESS=false` (numatytoji būsena). Anksčiau jie buvo tik streaming
šakoje — t. y. numatytoje konfigūracijoje neveikė visai.

---

## #154 — job fazių ir progreso state machine

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Du ATSKIRI grafai** (`transcription` ≠ `protocol`) | `jobPhase` | Bendras grafas leistų `transcription → generating_protocol`, kurio kode nėra |
| Nelegali `(type, phase)` pora atmetama | `jobPhase` | Patikros pašalinimas → `protocol + transcribing` praeitų |
| **Pavėlavęs įvykis iš ankstesnės fazės ignoruojamas** | `jobPhase` | Patikros pašalinimas → krinta; realus BullMQ replay atvejis |
| Monotoniškumas TIK `(jobId, phase)` ribose | `jobPhase` | `1000, 2000, 1500, 3000` → matomi `1000, 2000, 3000` |
| Fazės pasikeitimas = NAUJA progreso epocha | `jobPhase` | Naujoje fazėje mažas skaičius nėra regresija |
| Fazės perėjimas ATOMINIS progreso atžvilgiu | `jobPhase` | Atskiri `update()` paliktų matomą `diarizing + 4420/4420` |
| Terminalus perėjimas išvalo fazės būseną | `jobPhase` | Be to liktų `failed + transcribing + 3900/4400` |
| `progressKnown ↔ progress` invariantas | `jobPhase` | `true + null` atmetama — #155 kitaip persistintų dviprasmybę |
| `{current, total}` validacija (baigtiniai, `total>0`, `0<=current<=total`) | `jobPhase` | Procentinis ir sekundžių šaltiniai duoda tą patį UI elgesį |
| Helperis grynas — neturi vidinės būsenos, nekeičia įvesties | `jobPhase` | `Object.freeze` įvestis; determinizmo patikra |
| **Terminalaus job'o fazės pradėti negalima** | `jobPhase` | Be `status` patikros `completed + phase=null` atrodo kaip grafo pradžia — job'as „atgytų" |
| `queued + phase` ir `processing + phase=null` atmetami | `jobPhase` | Naujas writer'is neleistino derinio kurti negali |
| **`finish()` fail-closed'ina nežinomam šaltinio statusui** | `jobPhase` | `null`, `undefined` ar neatpažinta reikšmė (atkurtas legacy įrašas, būsima schema) tapdavo `completed`, apeidama `queued → completed` draudimą |
| `queued → completed` NELEIDŽIAMAS (`failed`/`cancelled` — taip) | `jobPhase` | Nevykdytas darbas negali būti baigtas sėkmingai; `queued → failed` yra realus enqueue klaidos kelias |
| **`total` stabilus fazės epochoje** | `jobPhase` | `50/100 → 60/200`: `current` auga, bet UI procentas kristų 50 % → 30 % |
| Grafas neeksportuojamas ir giliai užšaldytas | `jobPhase` | `Object.freeze` seklus — masyvus buvo galima papildyti runtime |

### Store integracija (2 žingsnis)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Neapdorotas `status`/`phase`/`progress` rašymas ATMETAMAS** | `jobPhaseStore` | `status` išėmimas iš sargo → krinta 2. Invariantas yra `status × phase × progress × progressKnown`, ne vien trys laukai |
| Sargas galioja IR vartotojo, IR sisteminiam `update()` | `jobPhaseStore` | Maršrutas kitaip sukurtų neteisingą terminalią būseną per nuosavybe ribotą kelią |
| **Terminalaus statuso negalima įrašyti apeinant `finish()`** | `jobPhaseStore` | Sukurtų `completed + phase=transcribing + progress=50/100` |
| `create()` NEGALI nustatyti fazės būsenos | `jobPhaseStore` | `fields.phase` priėmimas → antras writer'io apėjimas, šįkart per `create()` |
| **Fazių metodai gerbia ištrynimo žymą** | `jobPhaseStore` | Jie kviečia `store.update()` tiesiogiai, tad fasado apsauga jų NEdengia — vėluojanti žinutė „atgaivintų" ištrintą job'ą |
| `restart()` grąžina į grafo pradžią (BullMQ retry) | `jobPhaseStore`, `jobPhase` | `transcribing → validating` grafe nelegalus; perpaleidimas yra atskira operacija, ne atgalinis šuolis |
| Fazės perėjimas per store resetina progresą | `jobPhaseStore` | Tikrinamas įrašas po `startPhase`, ne tik grąžintas patch'as |
| Pavėlavęs įvykis nepakeičia įrašo | `jobPhaseStore` | `transcribing → diarizing →` pavėlavęs `transcribing` |
| Terminalus perėjimas iš BET KURIOS fazės išvalo būseną | `jobPhaseStore` | Visi trys terminalūs statusai |
| `queued → completed` atmetamas store lygmenyje | `jobPhaseStore` | `queued → failed` (enqueue klaida) lieka legalus |
| **`progressKnown` per Redis išlieka boolean** | `jobStoreRedis` | Pašalinus iš `BOOLEAN_FIELDS` → `"false"` yra truthy, diarizacija rodytų procentą |

### Dokumentacija (9 žingsnis)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Duomenų modelio blokas: `status` ir `phase` parsinami ATSKIRAI | `jobLifecycleDocumentation` | Sukeitus sąjungas vietomis bendra aibė nepakisdavo — testas praeidavo su neteisinga schema |
| Draudžiamos fazės IŠVEDAMOS iš `phasesForType()` | `jobLifecycleDocumentation` | Tikrinta tik pirmoji; `diarizing`/`merging` buvo galima ištrinti iš sąrašo. Trūkstama fazė IR neegzistuojanti reikšmė → krinta. ⚠️ Pakeitė du testus, kurie tikrino `doc.includes()` ir niekada nekrisdavo, kai kiti praeina |
| Įgyvendinimo lentelė: servisų keliai KONKRETŪS | `jobLifecycleDocumentation` | `backend/services/` neatitiko `.js` šablono, tad eilutės pašalinimo sargas nematė |
| **KIEKVIENO tipo PERĖJIMAI atitinka `transitionsForType()` ABIEM kryptim** | `jobLifecycleDocumentation` | Lyginamos BRIAUNOS. Mutacijos: neteisinga tvarka → krinta; nauja legali briauna `GRAPHS` be dokumento → krinta |
| Sinchroninis `generateProtocol()` kvietėjas paminėtas | `jobLifecycleDocumentation` | `routes/generate.js` kviečia servisą be job'o ir be `onPhase`; pagal senąjį aprašymą servisą būtų galima padaryti priklausomą nuo eilės ir sulaužyti `POST /api/generate` |
| **VISOS griežtumo lentelės eilutės** lyginamos su elgesiu | `jobLifecycleDocumentation` | Anksčiau tikrinta tik `finish()` celė — `restart`/`startPhase` eilutėse buvo galima parašyti „jokios" |
| Diarizacijos celės tikrina SEMANTIKĄ, ne raktažodžius | `jobLifecycleDocumentation` | `mode != "inline"` irgi turi „inline"; neigimas tenkindavo tą patį šabloną |
| Nežinomi terminalūs tikslai ATMETAMI, ne išfiltruojami | `jobLifecycleDocumentation` | `.filter(TERMINAL.includes)` tyliai išmesdavo neteisėtą `queued` |
| CAS kontraktas — struktūrinė žymė, ne teigiamas šablonas | `jobLifecycleDocumentation` | „Tai NĖRA reikalinga IR memory backend'ui" tenkindavo teigiamą regex |
| Kvietėjo blokas reikalauja FAZIŲ frazės atskirai | `jobLifecycleDocumentation` | Alternatyva `sinchronin\|be job'o\|...` tenkinta kitų variantų |
| Visos diarizacijos praleidimo sąlygos ATVEJŲ LENTELĖJE | `jobLifecycleDocumentation` | Trys atvejai, ne vienas. ⚠️ Sąlygos IŠVARDYTOS teste, ne parsinamos iš šaltinio — lygiavertis refactoringas (`const shouldDiarize = ...`) testo nebelaužo |
| Įgyvendinimo lentelė PILNA, ne tik neklaidinga | `jobLifecycleDocumentation` | Autoritetinis sąrašas, keliai imami TIK iš „Kur tai įgyvendinta" skyriaus. Mutacija: eilutės pašalinimas net paminėjus tą failą kitur dokumente → krinta |
| **UI tekstai susieti su FAZĖS RAKTU** | `jobLifecycleDocumentation` | Lyginamos poros, ne tekstų aibė. Mutacija: dviejų fazių tekstų sukeitimas → krinta |
| **Terminalūs PERĖJIMAI lyginami POROMIS su `finish()`** | `jobLifecycleDocumentation` | Tikrinama prieš realų `finish()` elgesį. Mutacija: viso `TERMINAL-TRANSITIONS` bloko pašalinimas → krinta (anksčiau statusų žodžiai liktų duomenų modelio lentelėje) |
| Progreso taisyklės sutampa su eksportuotu kontraktu | `jobLifecycleDocumentation` | Sąlygos imamos iš `PROGRESS_INVARIANTS`, ne šaltinio teksto. Dokumento nukrypimas → krinta |
| **`assertValidProgress()` VYKDO eksportuotus predikatus** | `jobPhase` | Deklaracija yra vykdymas — nuokrypis neįmanomas. Mutacija: grąžinus dubliuotas `if` sąlygas su `current < -0.5` → krinta |
| Tikrinamos RIBINĖS reikšmės, ne po vieną pavyzdį | `jobPhase` | `-0.3`, `-EPSILON`, `10.1/10`: vieno pavyzdžio predikatui nepakanka — susilpninta riba jį vis tiek atmestų |
| **Dokumentas NEPERŽADA media-level resume** | `jobLifecycleDocumentation` | Paneigimo pašalinimas → krinta. Persistintas `1872/4420` atrodo kaip resume taškas |
| Nurodyti įgyvendinimo failai realiai egzistuoja | `jobLifecycleDocumentation` | Pervadinus failą lentelė tyliai taptų klaidinga |
| **UI tekstai sutampa su frontend kodu** | `jobLifecycleDocumentation` | Pakeitus formuluotę tik viename — krinta |

⚠️ **Penki peržiūros raundai rado tą patį struktūrinį defektą.** `startPhase()`,
`finish()` ir `restart()` turėjo po DALINĘ tos pačios „ar įrašas nuoseklus?" patikros
kopiją, ir kiekvienas raundas rasdavo trūkstamą gabalą kitoje funkcijoje. Ištraukus
`assertConsistentJobRecord()` klausimas atsakomas vienoje vietoje — tai buvo pigiau
padaryti po pirmo raundo nei po penkto.

⚠️ **Dokumentas, kuris tyliai pasensta, yra blogesnis nei jo nebuvimas** — skaitytojas juo
pasitiki. Todėl tikrinamas SUTAPIMAS su kodu (`PHASE`, `STATUS`, `TERMINAL`,
`phasesForType()`, `assertValidProgress()`, `frontend/src/utils.js`), ne teksto
egzistavimas.

⚠️ **Šie sargai perėjo tris versijas, ir pirmosios dvi buvo silpnesnės už savo deklaraciją.**

1. Grafų patikra rėmėsi `doc.includes(faze)` — `protocol` grafe buvo galima įrašyti
   `transcribing`, nes ta fazė teisėtai minima `transcription` skyriuje. Ištaisyta:
   mašininiu būdu skaitomos `<!-- PHASE-GRAPH -->` žymės.
2. Progreso sąlygos buvo rankinis keturių elementų sąrašas, nors kodas turi penkias.
   Antroji versija parsino `assertValidProgress()` **šaltinį** regex'u — bet tai tikrino
   SINTAKSĘ, ne kontraktą: daugiaeilis `if (` ar sąlygos iškėlimas į helperį būtų sulaužę
   parserį nepakeitę elgesio. Ištaisyta: `jobPhase.js` eksportuoja `PROGRESS_INVARIANTS`,
   o atskiras testas tikrina, kad deklaracija neišsiskirtų su vykdymu.

3. Trečioji versija (eksportuotas kontraktas) vis tiek turėjo nuokrypį: `PROGRESS_INVARIANTS`
   deklaravo sąlygas, o `assertValidProgress()` jas įgyvendino ANTRĄ kartą `if` sakiniais.
   Susilpninus runtime patikrą į `current < -0.5`, sinchronizacijos testas praeidavo (jis
   ėmė po vieną pažeidžiančią reikšmę), o `-0.3` būtų priimta. Ištaisyta: validatorius
   VYKDO eksportuotus predikatus, plius ribinių reikšmių testai.

Tai tas pats defektų tipas, kurį fiksuoja `AGENTS.md` §9.1 — testas, kuris praeina, bet
nekristų pašalinus saugomą elgesį. Šįkart jis pasireiškė **tris kartus iš eilės**,
kiekviename bandyme jį taisyti. Visi trys rasti peržiūros, ne testų.

---

### Naršyklės fazių testas su perimtu API (8 žingsnis)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Fazių perėjimai matomi naršyklėje** | `phase-transitions.spec.js` (Playwright) | Frontend'ui ignoruojant `phase` → krinta: matomas tik vienas tekstas |
| **Pasenęs 100 % DINGSTA perėjus į diarizaciją** | `phase-transitions.spec.js` | Palikus procentą → krinta. Būtent „užstrigęs 100 %" ir buvo #154 pradinė problema |
| Mygtuko tekstas neprieštarauja fazei | `phase-transitions.spec.js` | Anksčiau šablonas `Transkribuojama (${progresas})` diarizacijos metu rodė „Transkribuojama (Atliekama diarizacija...)" |
| Užbaigus transkripcija patenka į formą | `phase-transitions.spec.js` | Regresija: fazių rodymas neturi sulaužyti rezultato kelio |

⚠️ **TAI NĖRA PILNAS E2E.** `GET /api/transcribe-jobs/:id` yra **perimtas**
(`page.route()`), tad backend fazių gamintojas čia netikrinamas — jį dengia 4–6 žingsnių
testai (`jobPhasePipeline`, `jobPhaseStore`, `jobPhaseApi`). Šis testas tikrina **naršyklės
reakciją į fazių kontraktą ir pasenusio progreso dingimą**, ne fazių gamybą ar
persistenciją.

⚠️ **Seka valdoma STATE'U SU ACKNOWLEDGEMENT.** Skaičiuoti „trečias poll'as grąžina
diarizaciją" būtų trapu: UI gali pollinti 1, 2 ar 4 kartus iki pirmojo patikrinimo. Bet ir
vien state pakeitimas nepakanka — tai ne handshake su polling mechanizmu. `route` handler'is
praneša, KURIĄ būseną grąžino, ir testas laukia to patvirtinimo prieš tikrindamas DOM.
Be jo kritęs testas neleistų atskirti „UI negavo naujos būsenos" nuo „UI gavo, bet
neatvaizdavo". Handshake turi SAVO 15 s timeout — kitaip polling'ui sustojus laukimą
nutrauktų tik bendras testo timeout, ir CI rodytų „testas užstrigo" vietoj
„diarizing poll neįvyko per 15 s". Mock provideris transkribuoja per milisekundes, tad be perimto API fazių
keitimasis įvyktų greičiau, nei Playwright spėtų perskaityti UI.

⚠️ **PIRMAS REALUS PLAYWRIGHT CI PALEIDIMAS BUVO RAUDONAS PRIEŠ FAZIŲ LOGIKĄ.**
Testas sustojo ties `page.setInputFiles('input[type="file"]', ...)`: po `page.goto("/")`
failo input'as dar nebuvo renderintas. Esamas žalias `audio-flow.spec.js` parodė tikrą
UI precondition: pirma reikia pasirinkti režimą **„Įkelti failą“**, tik tada atsiranda
`input[type="file"]`. Step 8 testas dabar naudoja tą patį setup'ą.

Šis CI kritimas **nepatikrino** phase route/polling/ACK/DOM perėjimų — testas jų nepasiekė.

Peržiūrint testą po to rasti dar DU selektoriai, kurie būtų kritę kitame žingsnyje:
`locator("textarea").first()` (puslapyje DVI `textarea` — `App.jsx:883` ir `894`, tad
`.first()` priklauso nuo DOM tvarkos) ir `toContainText` (`textarea` turinys yra `value`,
ne tekstinis mazgas). Abu pakeisti tais pačiais, kuriuos naudoja žalias
`audio-flow.spec.js`.

⚠️ **Tai antras kartas, kai selektoriaus klaida iškyla tik CI'e.** `playwright test --list`
tikrina sintaksę ir discovery, bet ne tai, ar selektorius pataiko. Rašant naują Playwright
testą verta sekti jau žalio testo selektorius pažodžiui, o ne pasirinkti „panašų".

✅ **PATVIRTINTA CI PALEIDIMU.**

<!-- CI-EVIDENCE:step8 -->
| | |
|---|---|
| Workflow run | [`#367`](https://github.com/forevercornix/stenograma/actions/runs/32235568074) (PR #174) |
| `e2e` job | [job/96014632889](https://github.com/forevercornix/stenograma/actions/runs/32235568074/job/96014632889) |
| Rezultatas | succeeded, 1 m 1 s |
| Žingsnis | „E2E testai (mock provideriai - pilnas srautas per naršyklę)" — 24 s |
| Chromium | „Diegti Playwright Chromium" — 22 s, sėkmingai |
| Ataskaita | „Įkelti Playwright ataskaitą (jei nepavyko)" — praleista (nebuvo kritimo) |
<!-- /CI-EVIDENCE -->

Tai vienintelis įrodymas, kurio Step 8 reikalauja: naršyklės vykdymas su realiai įdiegtu
Chromium. Ankstesnis paleidimas (#328) krito ties `setInputFiles`, tad žalias `e2e` job'as
reiškia, kad testas praėjo režimo perjungimą, `route` perėmimą, ACK handshake ir visus
keturis fazių perėjimus.

⚠️ **Teiginys „CI praėjo" be nuorodos į konkretų paleidimą nebūtų įrodymas** (`AGENTS.md`
§14). Ankstesnėje šio įrašo versijoje būtent taip ir buvo — Codex peržiūra tai pagavo.

---

### Frontend (7 žingsnis)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Progresas NĖRA sekundės — rodomas tik procentas** | `utils.test.js` (Vitest) | Laiko formatavimo grąžinimas → krinta 2. Backend siunčia `{42, 100}`; `formatSecondsToMMSS` būtų rodęs „00:42 / 01:40" — IŠGALVOTĄ trukmę |
| `progressKnown=false` NERODO procento NET kai `progress` yra | `utils.test.js` | Patikros pašalinimas → krinta. ⚠️ Su `progress: null` testas praeitų ir be `progressKnown` — reikia duomenų, kurie YRA, bet nebegalioja |
| **Procentas rodomas TIK kai `progressKnown === true`** | `utils.test.js` | `!== true` → truthiness krinta. `"false"` yra truthy: su truthiness patikra duotų „Atliekama diarizacija... 100 %" |
| Visos PENKIOS fazės turi savo tekstą | `utils.test.js` | `transcribing` pašalinimas → krinta 3. Parametrizuotas testas apima visas penkias |
| Nežinoma fazė duoda saugų fallback | `utils.test.js` | `undefined` grąžinimas → krinta. Backend gali pridėti fazę anksčiau nei frontend'as bus įdiegtas |
| `queued` nerodo vykdymo fazės teksto | `utils.test.js` | `status × phase` invariantas matomas ir UI |
| Netinkami progreso duomenys nesugriauna rodymo | `utils.test.js` | `NaN`, `total: 0`, trūkstami laukai |

⚠️ **Dvi ribos, viena reikšmė.** Backend riba FAIL-FAST'ina (`normalizeProgressKnown`
meta klaidą), UI riba FAIL-CLOSED'ina (`!== true` → procento nerodo). Frontend neturi
kurti silpnesnės to paties kontrakto interpretacijos: `"false"` yra truthy, ir jei backend
riba kada nors regresuotų, truthiness patikra parodytų 100 % ten, kur progresas nežinomas.
(Frontend Redis nemato — jis gauna HTTP JSON; rizika kyla iš backend normalizavimo, ne iš
saugyklos tiesiogiai.) Renderinimo metu mesti klaidą
būtų blogiau nei parodyti mažiau.

⚠️ **UI vienetų NEINTERPRETUOJA.** `progress` yra fazei lokalūs darbo vienetai (#154);
UI skaičiuoja tik santykį. Laiko rodymas reikalautų `unit` lauko, kuris paliestų API
kontraktą, memory/Redis modelį, state machine validaciją, CAS ir #155 schemą — ir dar
reikėtų apibrėžti, ar `current` yra apdoroto audio laikas, paskutinio segmento `end` ar
providerio offset. Tai atskiras darbas, ne frontend patobulinimas.

`formatSecondsToMMSS()` NEPAŠALINTAS — jis turi savo testus ir gali praversti tikroms
sekundėms; tik atsietas nuo job progreso.

---

### HTTP/API reprezentacija (6 žingsnis)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **ABU endpoint'ai grąžina tą patį fazių kontraktą** | `jobPhaseApi` | Atsakymai buvo sudaromi rankiniu būdu ir jau išsiskyrę: `progress` grąžindavo tik `/api/transcribe-jobs` |
| `phase`, `progress`, `progressKnown` pasiekia klientą | `jobPhaseApi` | `phase` pašalinimas iš serializatoriaus → krinta 5 |
| Diarizacijos fazė rodoma su `progressKnown=false` | `jobPhaseApi` | Būtent tas atvejis, dėl kurio #154 pradėtas: „užstrigo ties 100 %" |
| Terminalus job'as fazės nebeturi | `jobPhaseApi` | `status × phase` invariantas matomas ir per HTTP |
| **Vidiniai laukai į atsakymą NEPATENKA** | `jobPhaseApi` | `{ ...job }` vietoj allowlist → krinta. Su spread'u kiekvienas NAUJAS įrašo laukas automatiškai taptų viešas |
| Kiekvienas endpoint'as tikrinamas su SAVO tipo job'u ir 200 | `jobPhaseApi` | Vienas endpoint'as → 500 krinta 4. ⚠️ Ankstesnis `if (status !== 200) continue` bet kokią regresiją būtų pavertęs „praėjo" |
| **`extra` negali perrašyti kanoninių laukų** | `jobPhaseApi` | Grąžinus `...extra` į pabaigą → krinta. Endpoint'as galėtų perduoti `{ status: "completed" }` ir pakeisti state machine rezultatą atsakyme |
| **`progress` grąžina TIK viešus laukus** | `jobPhaseApi` | `{current, total, secret}` praeidavo nepakeistas — papildomi metaduomenys nutekėdavo pro abu endpoint'us |
| **Atmetus progresą, `progressKnown` TAIP PAT tampa `false`** | `jobPhaseApi` | Laukai skaičiuojami KARTU; atskirai API emitavo uždraustą `true + null` derinį |
| **VISI KETURI įėjimai naudoja `assertConsistentJobRecord()`** | `jobPhase` | `reportProgress()` buvo ketvirtas su sava patikra — progresas būdavo rašomas į sugadintą įrašą. Ten grąžinamas `null`, ne metama: fire-and-forget kelias |
| **Terminalus perėjimas nepavyksta NIEKADA dėl šaltinio būsenos** | `jobPhase` | `finish()` kviečiamas klaidos apdorojime; mesdamas jis prarasdavo pirminę klaidą ir palikdavo job'ą `processing` amžinai. Mutacija: grąžinus šaltinio patikrą → krinta 3 |
| Griežtumas atitinka išvesties priklausomybę nuo šaltinio | `jobPhase` | `restart()` tikrina (išvestis remiasi grafu), `finish()` — ne. Mutacija abiem kryptim → krinta |
| **Legacy įrašas TURI kelią iš `processing`** | `jobPhase` | ⚠️ Griežtinimas įvedė regresiją: `processing + phase=null` (iš prieš #154) nebegalėjo nei baigtis, nei būti perpaleistas. Tolerancija TIK atsigavimo keliams (`finish`, `restart`), ne pažangai (`startPhase`) |
| Tolerancija netaikoma SUGADINTIEMS įrašams | `jobPhase` | Svetimo grafo fazė ir nežinomas tipas atmetami visada. Mutacija: praplėtus toleranciją → krinta 2 |
| **VISI trys perėjimų įėjimai naudoja `assertConsistentJobRecord()`** | `jobPhase` | `restart()` priimdavo `queued + phase` ir svetimo grafo fazę, kurias `finish()`/`startPhase()` atmesdavo. Mutacija: grąžinus dalinę patikrą → krinta |

| **Netinkamas progress OBJEKTAS irgi normalizuojamas** | `jobPhaseApi` | Objektiškumo nepakanka: `{}`, `{current:2,total:1}` ir galiojantis objektas su `progressKnown=false` praeidavo. Tikrinamos tos pačios sąlygos, kurias vykdo state machine |
| **`restart()` fail-closed'ina nežinomam statusui** | `jobPhase` | `finish()` jau buvo pataisytas, `restart()` ne — legacy įrašas be `status` tyliai virsdavo `processing/validating` |
| **CAS priima EKSPONENTINĘ skaičiaus formą** | `jobPhaseCasRedis.integration` | `JSON.stringify(1e-7)` duoda `"1e-7"`; dešimtainis Lua šablonas skaitė kaip `1`, tad nepakitęs `total` atrodydavo pasikeitęs |
| **Legacy skaitinis `progress` normalizuojamas į `null`** | `jobPhaseApi` | Iki #154 rašytas neapdorotas procentas praeidavo nepakeistas — klientas gaudavo `progress: 42` su `progressKnown: false`, būseną už deklaruoto tipo ribų. NEverčiamas į `{current,total}`: `total` nežinomas |
| **Ne-boolean `progressKnown` yra KLAIDA, ne tylus vertimas** | `jobPhaseApi` | `Boolean("false") === true` — tylus konvertavimas paverstų „nežinomas" į „žinomas", ir neteisinga reikšmė atrodytų validi |
| `REZERVUOTI` sąrašas sinchronizuotas su realiais laukais | `jobPhaseApi` | Naujas laukas be sąrašo įrašo → krinta. Rankinis sąrašas be šios patikros būtų skola |
| `NEVIEŠI_LAUKAI` sąraše nėra pasenusių įrašų | `jobPhaseApi` | Nebeegzistuojantis laukas → krinta. Tikrinama prieš store KODĄ, ne `newJob()` formą — dalis laukų pridedama vėliau |

⚠️ **API riba FAIL-FAST'ina, ne taiso tyliai.** `progressKnown` ne-boolean reikšmė
reiškia, kad store normalizacija neveikia (laukas iškrito iš `BOOLEAN_FIELDS`) — tai
programavimo klaida, ne vartotojo įvestis. `undefined`/`null` lieka teisėti: legacy įrašai
lauko neturi.

⚠️ **Serializatorius naudoja ALLOWLIST.** Job įrašas turi tapatybės (`actor`, `ownerId`,
`actorSource`) ir saugyklos (`storageKey`) detalių. Su `{ ...job }` jos nutekėtų, o naujas
laukas įraše taptų viešas be jokio sprendimo. `NEVIEŠI_LAUKAI` sąrašas naudojamas teste —
tai greitasis sargas, ne pilna garantija: allowlist pati yra tikroji apsauga.

---

### Terminalūs, retry ir recovery keliai (5 žingsnis)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Tiesioginio `update(id, { status })` šablono nėra | `jobPhaseTerminal` (**greitasis grep**, ne pilna garantija) | Skenuojamas VISAS failas — eilučių skenavimas praleido daugiaeilius kvietimus. ⚠️ Neaptinka subkatalogų ir netiesioginės formos (`const patch = {...}`); tikroji apsauga yra store sargas |
| **INLINE atšaukimo kelias REALIAI pažymi `failed`** | `jobPhaseTerminal` | Elgesio testas per `_runInline()` su natūraliai atmesta autorizacija; `update({ status })` grąžinimas → krinta 3 |
| WORKER atšaukimo kelias naudoja tą patį `finish()` | `jobPhaseTerminal` (**struktūrinis**, ne elgesio) | Source-level mutacija krinta, bet runtime kelias NEVYKDOMAS — jam reikėtų tikro BullMQ |
| Retry iš BET KURIOS fazės grąžina į `validating` | `jobPhaseTerminal` | Tikrinamos visos keturios fazės |
| **Terminalaus job'o perpaleisti negalima** | `jobPhaseTerminal` | Patikros pašalinimas → `completed` grįžtų į `processing`, ir vartotojas matytų pažangą baigtame darbe |
| Nelegalus perėjimas job'ą pažymi SAVO kodu | `jobPhaseTerminal` | `ILLEGAL_TRANSITION`, ne `internal_error` |
| Nutrūkęs job'as lieka `processing` SU faze | `jobPhaseTerminal` | `processing + phase=null` neatsiranda net krentant worker'iui |
| **Progresas resetinamas per retry** | `jobPhaseTerminal` | Palikus jį UI rodytų 42 %, kai realus darbas ties 0 % — monotoniškumas NĖRA media-level resume |

⚠️ **Du atšaukimo keliai padengti SKIRTINGAI.** `jobRunner` (inline) turi ELGESIO testą:
`_runInline()` vykdomas realiai, autorizacija atmetama natūraliai, tikrinama galutinė store
būsena. `workers/index.js` turi tik STRUKTŪRINĮ: tikrinama, kad artimiausias kvietimas
prieš `AUTHORIZATION_REVOKED` yra `finish()`. Abu turi savo mutaciją, bet tai source-level
įrodymas, ne dviejų produkcijos kelių behavior coverage. Worker'io elgesio testas
reikalautų tikro BullMQ — verta pridėti, jei šis kelias kada nors išsiskirs su inline.

⚠️ **Rasta reali regresija.** Abu autorizacijos atšaukimo keliai (`jobRunner`, `workers`)
rašė `update({ status: FAILED })`, kurį #154 sargas meta — produkcijoje jie būtų kritę.
`workerAuthorization.test.js` to nepagavo, nes tikrino kodo TEKSTĄ
(`grep AUTHORIZATION_REVOKED`), ne elgesį: tekstas nepasikeitė, testas liko žalias.
Statinis sargas dabar tikrina priešingą kryptį — kad tokio rašymo apskritai nėra.

---

### Pipeline prijungimas (4 žingsnis)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **`onPhase` yra AWAITED ir blokuojantis** | `jobPhasePipeline` | Pavertus fire-and-forget → krinta. Fazei X priklausantis darbas gali prasidėti TIK po to, kai fazę X priėmė state machine |
| Fazės klaida SUSTABDO REALŲ diarizacijos darbą | `jobPhasePipeline` | Tikrinamas `diarize()` kvietimas per REGISTRY pakeitimą, ne `getDiarizationProvider` šnipas — servisas jį destruktūrizuoja, tad šnipas niekada nesuveiktų |
| Su veikiančiu `onPhase` diarizacija realiai vyksta | `jobPhasePipeline` | Kad ankstesnis testas neįrodinėtų vien to, jog diarizacija apskritai nevyksta |
| **PROCESSOR → STORE: progresas su faze ir `{current,total}`** | `jobPhasePipeline` | Adapteris gyvena processor'iuje, ne servise — kviečiant servisą tiesiogiai jis apeinamas. Tikrinama GALUTINĖ store būsena |
| Neteisinga fazė adapteryje = progresas dingsta | `jobPhasePipeline` | `TRANSCRIBING → DIARIZING` mutacija → krinta |
| **Protokolo fazė pradedama TIK po validacijos** | `jobPhasePipeline` | `generateProtocol()` atlieka 5 patikras; perėjus prieš jas UI rodytų „generuojamas protokolas" validacijos metu |
| **Fazės klaidos pranešime NĖRA vidinės informacijos** | `jobPhasePipeline` | `_classifyError()` `JobPhaseError.message` NESANITIZUOJA — tikrinami DABARTINIAI 10 padengtų kelių prieš kelius, raktus, stack trace. ⚠️ Sąrašas rankinis — naujas metimo kelias automatiškai nepatenka |
| `onProgress` lieka BEST-EFFORT | `jobPhasePipeline` | Progreso klaida transkripcijos nenutraukia — semantiškai nelygiavertis `onPhase` |
| Fazių tvarka atitinka realų srautą | `jobPhasePipeline` | `merging` pašalinimas → krinta; jis seka PO diarizacijos, nes sujungia jos rezultatą |
| Be diarizacijos praleidžiamos ABI fazės | `jobPhasePipeline` | `DIARIZATION_PROVIDER=none` |
| **Fazės pažeidimas gauna SAVO klaidos kodą** | `jobPhasePipeline` | Klasifikatoriaus šakos pašalinimas → `internal_error`, ir state corruption taptų neatskiriama nuo bet kokios vidinės klaidos |
| Progreso įvykis neša FAZĘ | `jobPhasePipeline` | Be jos store negali atskirti pavėlavusio įvykio iš ankstesnės fazės |

⚠️ **`onPhase` ir `onProgress` NĖRA lygiaverčiai.** Progreso įvykis gali dingti, pavėluoti
ar būti atmestas — rezultatas nenukenčia. Fazė yra state machine BŪSENA: jei perėjimas
neįsirašo, o darbas tęsiasi, store lieka senoje fazėje ir visi nauji įvykiai atrodo kaip
svetimos fazės. Rezultatas gali būti teisingas, o observability modelis — melagingas.

⚠️ **Servisas `jobStore` priklausomybės NETURI.** Jis tik laukia callback'o; store
prijungia `queues/processors.js`. Taip atominė state machine nelieka dekoracija, kurią
pipeline galėtų ignoruoti, bet sluoksniavimas išlieka.

---

### CI workflow struktūra

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Jokių DUBLIUOTŲ YAML raktų** | `workflowIntegrity` | Grąžinus nuslinkusį `run:` → krinta |
| **Kiekvienas step'as turi `run` arba `uses`** | `workflowIntegrity` | Pašalinus `run` → krinta |
| **`docs/decisions/` nuorodos tikrinamos IR `.env.example`, IR compose failuose** | `workflowIntegrity` | Pirmoji versija skenavo tik `README.md` ir `docs/*.md`, tad nutrūkusi nuoroda `.env.example` praėjo — o būtent ten vartotojas ją pamato pirmiausia |
| **Sprendimų įrašai (ADR) egzistuoja, nuorodos galioja** | `workflowIntegrity` | `rm -rf docs/decisions` generuojant pataisą ištrynė SEKAMUS failus, ir kitas `git add -A` tą užfiksavo. Mutacija: pašalinus ADR 0001 → krinta |
| **`docker compose config` žingsniai turi PRIVALOMUS kintamuosius** | `workflowIntegrity` | `${POSTGRES_PASSWORD:?}` neturi numatytosios reikšmės, tad net `config` be jo krinta — job'as krito CI'e. Mutacija: pašalinus `env` → krinta |

⚠️ **REALI KLAIDA, KURIĄ TAI PAGAVO.** Pridedant PostgreSQL žingsnį,
`run: npm run test:redis` nuslinko į kitą step'ą: Redis liko BE `run` (nieko
nevykdė), o Postgres gavo DU `run` raktus — YAML pasilieka paskutinį, tad
`npm run test:postgres` niekada nebūtų paleistas. **Abu žingsniai būtų likę
žali.**

YAML 1.2 dublikuotus raktus DRAUDŽIA, bet `js-yaml` ir PyYAML numatytai jų
neatmeta — tyliai pasilieka paskutinę reikšmę. Todėl tikrinama TEKSTU, ne
parseriu.

---

### PostgreSQL karkasas (#155, 7.1)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Tuščia DB → dabartinė schema | `migrations.integration` | Paleista prieš TIKRĄ PostgreSQL, ne praleista |
| Antras `migrate:up` = no-op | `migrations.integration` | ⚠️ Su TIKRA fixture migracija: be jos abi užklausos grąžintų tuščias aibes ir testas praeitų nieko netikrindamas. Mutacija: pašalinus fixture → krinta |
| **Be `DATABASE_URL` PostgreSQL eilutės NĖRA** | `postgresDoctor.integration` | Desktop režimu „nepasiekiamas" būtų klaidinantis įspėjimas. Mutacija: rodyti visada → krinta |
| **Prisijungimo eilutė NEPATENKA į diagnostiką** | `postgresDoctor.integration` | `DATABASE_URL` turi slaptažodį, o išvestis keliauja į support-bundle. Rodomas tik hostas. Mutacija: rodyti visą URL → krinta |
| **`doctor.js` KVIEČIA `runSelfChecks()`, ne tik mini** | `postgresDoctor.integration` | Komentarai pašalinami prieš tikrinant: paaiškinimas mini `runSelfChecks` tris kartus, tad pašalinus kvietimą sargas liktų žalias. Mutacija: pašalinus importą+kvietimą → krinta |
| **`doctor.js` neturi TIESIOGINĖS `pg` patikros** | `postgresDoctor.integration` | Turėjo, ir elgesys skyrėsi: be DATABASE_URL rodė OK, be migracijų rodė OK, o klaidoje – `e.message` su vartotojo vardu. Mutacija: grąžinus `require("pg")` → krinta. ⚠️ Testas saugo nuo TIESIOGINIO `pg`, ne nuo bet kokio antro kelio (pvz. atskiro modulio) |
| **`DATABASE_URL` + `PG*` kartu = KLAIDA, ne pirmenybė** | `postgresDoctor.integration` | Docker naudoja `PG*`, o `.env` dažnai turi `DATABASE_URL`; `doctor` skaito abu failus, tad tikrintų NE TĄ DB. Diagnostika, rodanti kitą duomenų bazę, blogesnė nei jos nebuvimas |
| **Komponento vardas NEŽADA neįgyvendintų integracijų** | `postgresDoctor.integration` | 7.1 metu jobStore, sesijos ir auditas PostgreSQL nenaudoja; „job store, sesijos, auditas" reikštų, kad įrašai jau persistenti |
| **Prisijungimo klaidos atskiriamos pagal kodą** | `postgresDoctor.integration` | `28P01`, `3D000`, `42501` reikalauja skirtingų veiksmų; viena „ar servisas paleistas?" siuntė klaidinga kryptimi |
| **Veikianti DB be migracijų atskiriama nuo neveikiančios** | `postgresDoctor.integration` | Du gedimai, du skirtingi veiksmai. Mutacija: praleisti `pgmigrations` patikrą → krinta |

---

### PostgreSQL job store (#155, 7.2a)

⚠️ **KODĖL SAUGUMO MATRICOJE.** `postgresStore` saugo ne vien duomenų
korektiškumą: `owner_kind × owner_id` yra nuosavybės riba (#159), o
`persistentStorage` yra tai, ką operatorius skaito priimdamas sprendimą, ar
jautrūs įrašai išgyvena restartą. Klaida bet kurioje iš šių vietų yra saugumo
arba duomenų praradimo klaida, ne stiliaus.

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **`owner_kind = NULL` + `owner_id` ATMETAMAS DB lygmenyje** | `postgresStore.integration` | `CHECK` atmeta tik `FALSE`, o `UNKNOWN` **priima**. Mutacija: `CASE` → `OR` grandinė → DB priima nuosavybės būseną, kurios `assertOwnerIdentity()` sukurti negali → krinta |
| **`status` ir `progress_known` yra `NOT NULL`** | `postgresStore.integration` | Su `NULL` abi `CHECK` šakos duotų `UNKNOWN`, ir eilutė, kurią `assertConsistentJobRecord()` atmeta, būtų patvirtinta. Mutacija: nuimti `NOT NULL` → krinta |
| **Nuosavybė NEPERDUODAMA per `updateOwned`** | `postgresStore.integration` | Realizacija, atvaizduojanti patch'ą tiesiai į `SET`, autorizuotų kaip savininkas A ir perduotų eilutę savininkui B. Mutacija: įtraukti `owner_id` į `SET` → krinta |
| **`unowned` ir `api-key` NESUSILIEJA** | `postgresStore.integration` | Abu turi `owner_id IS NULL`; be `ownerKind` palyginimo desktop scope pasiektų bendro rakto job'us. Mutacija: lyginti tik `owner_id` → krinta |
| **`getOwned` skiria `null` (404) nuo `FORBIDDEN` (403)** | `postgresStore.integration` | Sulieti reikštų atskleisti job'o egzistavimą arba slėpti savo paties. Mutacija: grąžinti `null` abiem → krinta |
| **Rezultatas grąžinamas, ne tyliai prarandamas** | `postgresStore.integration` | Transkripcijos gyvena `job_results`, o `jobResponse.js` skaito `job.result`: be `LEFT JOIN` realizacija sėkmingai IŠSAUGOTŲ transkripciją ir grąžintų `result: null` KIEKVIENAM klientui. Mutacija: pašalinti hidrataciją → krinta |
| **`listReferencedStorageKeys()` grąžina GYVUS raktus** | `postgresStore.integration` | `retentionSweeper` reikšmę traktuoja kaip įrodymą, kad joks job'as neberodo į audio, ir failus IŠTRINA. Mutacija: grąžinti `[]` → metodų aibės patikra praeitų, šis krinta |
| **Nebaigto valymo job'ai NEŠALINAMI per TTL** | `postgresStore.integration` | Toks įrašas gali būti vienintelis `storageKey` šaltinis; jį išmetus audio taptų nebeatsekamas. Mutacija: nuimti `audio_cleanup_pending` filtrą → krinta |
| **Idempotency raktas atmetamas DB, ne aplikacijoje** | `postgresStore.integration` | ⚠️ `newJob()` neturėjo `idempotencyKey`, tad `INSERT` siųstų `NULL`, o dalinis indeksas `NULL` neapima — indeksas būtų dekoracija. Mutacija: pašalinti lauką iš `newJob()` → krinta |
| **Idempotency raktas IŠLIEKA po `update()`** | `postgresStore.integration` | ⚠️ `rowToJob()` jo nehidratavo, tad pirmas gyvavimo ciklo `update()` rašė `NULL` ir pakartotinis `create()` PRAEIDAVO — idempotency dingdavo per ĮPRASTĄ round-trip. Ankstesnis testas to nepagavo, nes tarp dviejų `create()` nedarė `update()`. Mutacija: pašalinti hidrataciją → krinta |
| **Idempotency raktas NEKINTAMAS** | `postgresStore.integration` | Jis identifikuoja KŪRIMO ketinimą; leidus keisti, du ketinimai susilietų arba vienas atsilaisvintų. Mutacija: leisti `SET` → krinta |
| **Legacy `processing + phase=NULL` PRIIMAMAS** | `postgresStore.integration` | #154 laiko jį realiu pre-#154 kopijų formatu; `CHECK`, jį atmetantis, nutrauktų restore per pusę. Mutacija: uždrausti → krinta |
| **`schemaVersion` normalizuojamas visuose backend'uose** | `jobOwnership` | `assertSupportedSchemaVersion()` lygina `=== 2`, tad `"2"` runtime atmeta. Redis konvertuoja (`NUMERIC_FIELDS`), PostgreSQL - per `integer` stulpelį, o memory be normalizavimo paliktų eilutę: tas pats įrašas būtų vykdomas dviejuose backend'uose ir nevykdomas trečiame |
| **Pasenusi schema NUTRAUKIA startą** | `migrations.integration` | Lentelių buvimo nepakanka: DB su tik pirmąja migracija abi turi, tad readiness praeitų, o DB priiminėtų įrašus, kuriuos naujesnė migracija blokuoja. Tikrinami CONSTRAINT'AI. Mutacija: nuimti patikrą -> krinta |
| **`actor_source` aibė uždara** | `dbRuntimeParity.integration` | `resolveCurrentRole()` erai 2 meta `Nežinomas actorSource`, o `_validateContent()` tikrina tik job ID - atkurta eilutė su `'service'` būtų įrašyta, restore praneštų SĖKMĘ, o job'as niekada nepasileistų. `NULL` lieka leistinas (`no_actor` passthrough) ir tai patikrinta prieš tikrą autoritetą. Mutacija: įsileisti `'service'` -> krinta |
| **Skaitinės aibės parseris atsparus deparse formai** | `dbRuntimeParity.integration` | PostgreSQL `IN (2, 4)` deparsina kaip `= ANY (ARRAY[2, 4])`; šablonas, ieškantis tik po `=`, iš jo neištrauktų nieko, aibė liktų tuščia ir testas praeitų nieko netikrindamas. Mutacija: `IN (2, 4)` -> krinta |
| **`IMMUTABLE_COLUMNS` lyginama kaip PILNA aibė** | `postgresStore.integration` | Narystės patikra po vieną tikrina tik apatinę ribą: pridėjus `status`, `writePatched()` jį praleistų KIEKVIENAME atnaujinime - job'as niekada nepakeistų statuso, ir testai liktų žali. Mutacija: pridėti `status` -> krinta 6 testai |
| **DB allowlist AIBĖ sutampa su runtime** | `dbRuntimeParity.integration` | ⚠️ Vieno sentinelio atmetimas neįrodo nieko: SQL, įsileidęs `summary` ir toliau atmetantis `bogus`, paliktų testą žalią. Aibė skaitoma iš `pg_get_constraintdef()` ir lyginama su runtime konstanta. Mutacija: pridėti `summary` į SQL -> krinta |
| **Constraint'ų sugriežtinimas pasiekia JAU MIGRUOTAS DB** | `migrations.integration` | ⚠️ `node-pg-migrate` praleidžia failą pagal VARDĄ, tad pakeitus jau išsiųstą migraciją švarios DB testai praeitų, o egzistuojančios liktų su laisva schema - tyliai, nes antras `migrate:up` teisėtai yra no-op. Keitimai iškelti į naują `1755100000000_` migraciją |
| **DB aibės SUTAMPA su runtime autoritetais** | `dbRuntimeParity.integration` | Trys iš eilės peržiūros radiniai buvo TAS PATS defektas: `schema_version` priėmė `1`, `type` priėmė bet ką ne-`processing` eilutėse, `phase` priėmė bet kokį tekstą. Sąrašai IŠVEDAMI iš `JOB_TYPES`/`STATUS`/`OWNER_KIND`/`phasesForType()`/`assertSupportedSchemaVersion()`, tad naujas tipas ar fazė be migracijos krinta iškart. Mutacija: pridėti `JOB_TYPES.SUMMARY` be migracijos -> krinta |
| **Laisvesnė DB nei runtime = TYLI divergencija** | `dbRuntimeParity.integration` | Griežtesnė DB atmeta teisėtą įrašą garsiai; laisvesnė - įrašo sėkmingai, restore praneša SĖKMĘ, o gedimas išlenda vėliau kaip `UNKNOWN_JOB_TYPE` ar `Nepalaikoma job schemaVersion` ant įrašo, kurio niekas nebegali paleisti |
| **PostgreSQL startas turi BAIGTINĘ prisijungimo ribą** | `jobStoreBackendSelection` | `pg` numatytasis `connectionTimeoutMillis` yra 0 = be ribos. Endpoint'as, tyliai numetantis TCP srautą, paliktų startą kabantį ir NIEKADA nepasiektų `catch` bloko su fail-closed klaida - procesas liktų nepasiekiamas be paaiškinimo |
| **Fazė privalo TIKTI job tipui** | `postgresStore.integration` | `phase IS NOT NULL` praleistų `type='protocol', phase='transcribing'` ar `'bogus'`, o `assertPhaseAllowedForType()` tokią porą atmeta - sugadinta kopija būtų įrašyta, o progreso/perkrovimo operacijos ant jos kristų. Aibės sutapimą su `phasesForType()` tikrina atskiras testas |
| **`schema_version` tik iš palaikomos aibės** | `postgresStore.integration` | `schemaVersion: 3` iš ateities kopijos praeitų `_validateContent()`, atkūrimas praneštų SĖKMĘ, o `authorizeJobExecution()` vėliau mestų „Nepalaikoma job schemaVersion" - job'as niekada nepasileistų |
| **Valymo pakartojimo TERMINAI persistinami** | `postgresStore.integration` | ⚠️ `deletionRetry.js` juos rašo per `update()`, o memory/Redis bet kokį patch'o lauką išsaugo. Be stulpelio PostgreSQL juos išmestų TYLIAI: kitas praėjimas job'ą laikytų iškart vykdytinu - eksponentinis backoff nustotų veikti po KIEKVIENO restarto |
| **`listByFlag()` NEHIDRATUOJA rezultatų** | `postgresStore.integration` | Valymo ciklai naudoja tik metaduomenis; `LEFT JOIN payload` su 100 job'ų ir 20 MiB riba pertemptų kelis GiB - prieštarautų priežasčiai, dėl kurios rezultatai iškelti į atskirą lentelę |
| **`memory` + `REDIS_REQUIRED=true` = klaida** | `jobStoreBackendSelection` | `REDIS_REQUIRED` reiškia „fallback į atmintį yra kritinė klaida", bet eksplicitinis `memory` atmintį parenka PRIEŠ bandant Redis - garantija būtų apeita nė karto nesuveikusi |
| **Persistencijos klaida įvardija BARJERĄ** | `privacyConfig` | Su vienu `DATABASE_URL` tekstas „nei DATABASE_URL nenustatytas" yra netiesa ir siūlo veiksmą, kuris nepadėtų - URL jau yra, o startas vis tiek krinta |
| **DABARTINĖS eros `processing + phase=NULL` ATMETAMAS** | `postgresStore.integration` | Besąlyginė išimtis priimtų ir `schema_version=2` įrašą, kurį `assertConsistentJobRecord()` (`jobPhase.js:166`) atmeta kaip `INVALID_STATUS_PHASE` — sugadinta nauja kopija būtų įrašyta ir užstrigtų. Mutacija: nuimti `schema_version IS NULL` sąlygą → krinta |
| **`schemaVersion` išgyvena round-trip; legacy jo NEGAUNA** | `postgresStore.integration` | `resolveCurrentRole()` pagal jį sprendžia, ar `actor` yra UUID; pametus — job'as eitų legacy keliu ir vykdymas būtų atmestas. `null` ≠ nesantis: `applyPatch()` tikrina `"schemaVersion" in job` |
| **DB `CHECK` atitinka VISUS `PROGRESS_INVARIANTS`** | `postgresStore.integration` | Sąrašas IŠVEDAMAS iš `PROGRESS_INVARIANTS`, ne surašomas: naujas invariantas be atitikmens krinta ties `deepEqual`, o ne lieka žalias. `NaN` gaudomas per `<> 'NaN'::float8`, nes PostgreSQL'e `NaN = NaN` yra TRUE |

### Backend'o parinkimas ir aktyvavimo barjeras (#155, 7.2a)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **`DATABASE_URL` NEPERJUNGIA job metaduomenų** | `jobStoreBackendSelection` | Aktyvavimo barjeras; rollback į Redis nepalaikomas. Mutacija: `POSTGRES_AKTYVAVIMAS_LEISTAS = true` → krinta 7 testai (sąmoningai pastebimai) |
| **Eksplicitinis `JOB_STORE_BACKEND=postgres` = KLAIDA** | `jobStoreBackendSelection` | Numanomą `DATABASE_URL` galima aiškinti kaip „reikia DB sesijoms"; eksplicitinį nurodymą ignoruoti tyliai negalima |
| **Nežinoma `JOB_STORE_BACKEND` reikšmė = klaida, ne fallback** | `jobStoreBackendSelection` | Rašybos klaida (`postgress`) tyliai virstų in-memory režimu, o operatorius manytų, kad job'ai išgyvena restartą |
| **`persistentStorage` išvedamas iš FAKTINIO backend'o** | `privacyConfig`, `jobStoreBackendSelection` | ⚠️ Tarpinė šio darbo versija naudojo `Boolean(REDIS_URL \|\| DATABASE_URL)` ir MELAVO: su vienu `DATABASE_URL` job'ai lieka atmintyje, o nuostatos skelbė persistenciją. Mutacija: grąžinti env išvedimą → krinta 3 testai |
| **Eilė reikalauja `REDIS_URL` IR bendro backend'o** | `jobStoreBackendSelection` | Gryna `canUseQueue(env, backend)` — visi 6 deriniai tiesiogiai. Mutacija: apversta semantika → krinta 5; „būtent Redis" → 2; kiekvienos sąlygos pašalinimas → po 1 |
| **`memory` metaduomenys IŠJUNGIA BullMQ (sąmoninga išimtis)** | `jobStoreBackendSelection` | Worker'is atskirame procese atnaujintų savo atminties kopiją; klientas amžinai apklausinėtų `queued` job'ą, kuris kitur jau baigtas |
| **Eksplicitinis backend'as be savo priklausomybės = klaida** | `jobStoreBackendSelection` | `JOB_STORE_BACKEND=redis` be `REDIS_URL` tyliai paleisdavo atmintį: operatorius paprašo Redis, servisas pakyla, job'ai dingsta po restarto — be jokio įspėjimo, nes jungtis nė nebandoma. Mutacija: nuimti patikrą → krinta |
| **Schema tikrinama prieš readiness** | `jobStoreBackendSelection` | `SELECT 1` pavyksta ir be migracijų; `readiness.jobStore=true` tada reikštų, kad pirma job operacija kris su `relation "jobs" does not exist` JAU PRIĖMUS vartotojo failą |
| **`jobRunner` numatytoji reikšmė NEREMIASI `REDIS_URL`** | `jobStoreBackendSelection` | `init()` atsarginis kelias buvo `!!process.env.REDIS_URL` — negyvas TIK netiesiogiai (`server.js` visada perduoda). Du testai juo RĖMĖSI, tad kelias buvo gyvas: kvietėjas be argumento gautų `true` vien dėl env, o HTTP procesas kurtų job'ą atmintyje ir siųstų į BullMQ, kur worker'is jo nerastų. Mutacija: grąžinti `!!REDIS_URL` → krinta |
| **Eilės sprendimas VIENAS visiems procesams** | `jobStoreBackendSelection` | `workers/index.js` ir `queues/jobRunner.js` anksčiau reikalavo `getBackend() === "redis"`. Atidarius barjerą su DB+Redis, HTTP procesas dėtų į BullMQ, o kiekvienas worker'is kristų starte — darbas liktų eilėje be vykdytojo |
| **Prisijungimo klaida NEGRĮŽTA į memory (fail-closed)** | `jobStoreBackendSelection` | Fallback reikštų split-brain: nauji job'ai atmintyje, autoritetingi — DB. ⚠️ **PARTIAL:** įrodyta unit lygmeniu (`_initializePostgresForTests`); pilnas produkcinis kelias nepasiekiamas, kol barjeras uždarytas — acceptance perkeltas į aktyvavimo etapą |

⚠️ **Šie testai ilgai buvo NEMATOMI.** `migrations.integration` egzistavo, bet be
`DATABASE_URL` visada praleisdavo save, o matricos sargas tikrino tik `privacy` ir
`security` rinkinius — tad `redis` ir `postgres` testai galėjo atsirasti be nė vieno
įrašo. Sargas dabar apima visus invariantų rinkinius.

`functional` sąmoningai neįtrauktas: tai saugumo matrica, ne visų testų registras.

---

### Backend'ų kontrakto ekvivalentumas

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Aktoriaus eros CAS Redis'e | `actorEraRedis.integration` | Pasenusios eros įvykiai atmetami atomiškai |
| **Abu backend'ai duoda TĄ PATĮ rezultatą 7 scenarijams** | `jobStoreBackendContract.integration` | Grąžinus Redis į būseną prieš pataisymą → krinta |
| Abu deklaruoja tą pačią metodų aibę | `jobStoreBackendContract.integration` | Metodo pašalinimas → krinta 3. Trūkstamas metodas reikštų tylų grįžimą į atsarginį kelią |

⚠️ **BACKEND'AI BUVO IŠSISKYRĘ, IR TESTO NEBUVO.** `reportProgressAtomic()` sugadintam
įrašui (`protocol` su svetimo grafo faze) memory ATMESDAVO, o Redis PRIIMDAVO —
`memoryStore` kviečia `jobPhase.reportProgress()`, o Lua tokios patikros neturėjo.
Fasadas tai maskavo (tikrina pirmas), bet backend'o kontraktas yra kontraktas.

Pataisyta **be ketvirtos taisyklių kopijos**: `redisStore` jau skaito įrašą prieš Lua, tad
kviečia tą pačią gryną funkciją. Konsistencija nėra lenktynėms jautri savybė — tipas
nekinta, o fazės pasikeitimą Lua tikrina atskirai.

⚠️ **#155 PRIDĖS TREČIĄ REALIZACIJĄ.** `postgresStore` privalo gauti įrašą `BACKENDAI`
sąraše šiame teste. ADR 7.2b tai reikalauja; dabar žinoma, kad reikalavimas nėra teorinis —
divergencija atsirado jau su dviem.

---

### Atominis progreso CAS (3 žingsnis)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| **Fazės pakeitimas TARP skaitymo ir rašymo atmeta pasenusį progresą** | `jobPhaseCasRedis.integration` | Lua fazės patikros pašalinimas → krinta |
| Monotoniškumas tikrinamas Lua viduje, ne tik JS | `jobPhaseCasRedis.integration` | Lua `current` patikros pašalinimas → krinta |
| `total` stabilumas tikrinamas Lua viduje | `jobPhaseCasRedis.integration` | Lua `total` patikros pašalinimas → krinta |
| **Memory backend'as TAIP PAT turi atominį progreso kelią** | `jobPhaseStore` | Fasado `await store.get()` atveria langą: 50 → vienu metu 60 ir 55 → išsaugoma 55. Komentaras anksčiau teigė, kad CAS čia nereikalingas |
| **FASADAS naudoja atominį kelią, ne `store.update()`** | `jobPhaseCasRedis.integration` | Grąžinus `read → check → write` → krinta. Be šio testo kiti trys liktų žali, o langas atsivertų |
| Normalus progresas praeina | `jobPhaseCasRedis.integration` | Apsauga nėra aklas blokas |
| **Lygiagretus NESUSIJUSIO lauko pakeitimas IŠLIEKA** | `jobPhaseCasRedis.integration` | Platus `HSET` iš pasenusio snapshot'o → krinta. Kitaip progreso įvykis anuliuotų #159 `ownerId` CAS rezultatą |

⚠️ **Lenktynių testas turi būti DETERMINISTINIS.** „Paleisti abu lygiagrečiai ir tikėtis
lenktynių" nepakanka: `await` seka reiškia, kad fasadas spėja baigti prieš pakeitimą, ir
testas praeina net be atomiškumo. Langas atidaromas perimant backend'o `get()` (fasado
kelyje) arba `eval()` (tiesioginiame) — t. y. PO to, kai JS pusė jau priėmė sprendimą.
Ta pati pamoka kaip #159 `ownerId` CAS.

⚠️ **CAS rašo SIAURAI, ne visą job'ą.** Rašomi tik `progress`, `progressKnown` ir
`updatedAt`. Pirmoji versija rašė visą serializuotą įrašą iš `get()` snapshot'o — tai
būtų kitas TOCTOU variantas: lygiagretus `ownerId` CAS būtų atsuktas atgal. CAS, kuris
saugo tris laukus, bet perrašo visus, nėra atominis mutavimas.

⚠️ **`flushdb()` pašalintas iš VISŲ Redis testų.** `node --test` failus vykdo
LYGIAGREČIAI, tad viso DB išvalymas naikina kitų failų būseną vidury darbo. Tai nebuvo
teorinė rizika: #154 metu pasireiškė kaip nestabilūs testai, kurių klaidos keitėsi kas
paleidimą (`listAll()` grąžindavo 4 arba 9 vietoj 3, koreliacijos laukai tapdavo `null`).
Testai, rėmęsi „DB yra tuščias", perrašyti tikrinti tik savo įrašus; kiekvienas valo tik
savo raktus. Patikrinta trimis paleidimais ant vis nešvaresnio DB — žr.
`helpers/redisGuard.js`.

⚠️ **CAS reikalingas ABIEM backend'ams.** Teiginys „memory backend'e lenktynių nėra, nes `get` ir `update` vyksta be `await` tarp jų" buvo neteisingas: fasadas daro `await store.get(id)`, ir tas `await` atveria langą. Progreso kelias yra fire-and-forget, tad persidengimas vyksta natūraliai. Abu backend'ai dabar turi `reportProgressAtomic()`.

⚠️ **Grynas helperis vienas NEPAKANKA.** `jobPhase.reportProgress()` sprendžia pagal
perduotą būseną. Fasade jis paliekamas kaip greitasis kelias (atmeta akivaizdžiai
netinkamus įvykius ir sutaupo Redis kvietimą), bet AUTORITETINGA patikra yra atominiame
backend'o metode — abiejuose, žr. įrašą apie `reportProgressAtomic()` aukščiau.

⚠️ **Klaidos ir atšaukimo keliai privalo eiti per `finish()`.** Konstruojant neapdorotus
`jobStore` patch'us `status × phase` invariantas galiotų normaliame sraute, bet būtų
pažeidžiamas būtent klaidos metu — ten, kur diagnostika svarbiausia.

---

## Redis ir persistencija

| Garantija | Testai | Pastaba |
|---|---|---|
| Restart ir stalled recovery | `queueRecovery.integration` | Reikia tikro Redis |
| Worker heartbeat → readiness | `heartbeatReadiness.integration` | Reikia tikro Redis |
| Koreliacija išgyvena saugyklos ratą | `redisConcurrency.integration` | `null` round-trip mutacija |
| Ištrynimas **išgyvena restartą** | `redisConcurrency.integration` | `remove()` no-op → krinta 2 |

⚠️ **Redis testai dalijasi eilėmis ir `process.env`.** Worker'is, paleistas ant bendros
eilės, pasiima BET KURĮ joje esantį job'ą — įskaitant kitų testų. #153 metu testas su
sumažinta `MAX_RESULT_BYTES` riba numarino `stalled recovery` testo job'ą; krito svetimas
testas, o priežastis buvo kitame faile. Naujuose testuose naudokite unikalų eilės
pavadinimą ir venkite globalių `process.env` pakeitimų — abu spąstai nematomi paleidžiant
testą po vieną. Detaliau: `tests/helpers/redisGuard.js`.

⚠️ Šie testai praleidžia save be `REDIS_URL`, bet CI nustato **`REQUIRE_REDIS=1`**,
ir tada praleidimas tampa klaida. Be to dingęs `REDIS_URL` reikštų žalią job'ą,
kuris nieko nepatikrino.

---

## Ko ši matrica NEAPIMA

Sąžiningumo dėlei — ribos, kurios lieka atviros:

- **Semantinis PII aptikimas.** Redakcija yra leksinė; perfrazuoti arba žodžiais
  padiktuoti identifikatoriai praeina. Rezultatas yra dalinai pseudonimizuotas,
  **ne anonimizuotas**.
- **Vizualinė regresija.** Nei testai, nei CI netikrina spalvų, tarpų ar fokuso
  indikatorių — Tailwind v4 migracijoje tai teko tikrinti rankomis.
- **Realus GPU kelias.** `pyannote`/`whisper` GPU vykdymas tikrinamas tik
  kontraktų lygiu su mock modeliais.
- **Apkrovos ir laiko atakos.** Rate limitas testuojamas funkciškai, ne po
  apkrova.
- **BullMQ worker procesas.** `redisConcurrency` konteksto atkūrimą tikrina per
  inline kelią; atskirą procesą dengia `queueRecovery.integration`.

### #180 — SQL CAS ir trijų backend'ų kontrakto ekvivalentumas

| Garantija | Testas | Mutacijos įrodymas |
|---|---|---|
| Memory ir Redis vykdo VISUS progreso scenarijus; PostgreSQL - visus, kuriuos jo schema atstovauja (likusieji EKSPLICITIŠKAI deklaruoti, ne tyliai praleisti) | `jobStoreBackendContract.integration` | Pašalinus backend'o progreso guard arba ištrynus privalomą scenarijų → krinta lūkesčiai arba `PRIVALOMI_SCENARIJAI` pilnumo patikra įvardija trūkstamą `id` |
| ⚠️ PostgreSQL kontrakto paleidimas naudoja NEPAKEISTĄ produkcinę schemą; dvi sąmoningai sugadintos būsenos (`svetimo-grafo-faze`, `processing-be-fazes`) vykdomos ATSKIROJE sintetinės schemos DB be `jobs_status_phase` ir NĖRA produkcinės schemos įrodymas | `jobStoreBackendContract.integration` | Grąžinus `DROP CONSTRAINT` į bendrą kontrakto DB → krinta `jobs_status_phase` buvimo patikra adapterio paruošime |
| ⚠️ Dvi pre-būsenos (`skaitines-eilutes`, `ideti-metaduomenys`) PostgreSQL'e NEATSTOVAUJAMOS ir jo NEVYKDOMOS; padengimas skaičiuojamas kaip įvykdyta / eksplicitiškai neatstovaujama / trūksta | `jobStoreBackendContract.integration` | Pašalinus `neatstovaujama` deklaraciją → scenarijus tampa MISSING ir pilnumo patikra krinta pagal `id` |
| `updateOwned` / `removeOwned` nuosavybės CAS ir immutable laukai sutampa | `jobStoreBackendContract.integration`, `postgresStore.integration` | Pašalinus scope iš mutacijos sąlygos arba leidus patch'ui keisti nuosavybę / erą → svetimas scope mutuoja job'ą arba immutable assertions krinta |
| `getOwned` atskiria owner, svetimą scope ir neegzistuojantį job | `jobStoreBackendContract.integration` | Grąžinus job'ą nepatikrinus abiejų scope laukų → `api-key` ir `unowned` neigiamas scenarijus krinta |
| PostgreSQL progreso CAS lygina pilną perskaitytą snapshot'ą | `postgresStore.integration` | Kontroliuojamai pakeitus fazę tarp read ir CAS → `UPDATE` turi pakeisti 0 eilučių ir grąžinti `REJECTED` |

### #181 — persistentinės sesijos (#155, 7.3)

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| DB saugo TIK `token_hash`; cookie reikšmė nėra nei `sessions.id`, nei maiša | `sessionTokenHash`, `sessionPersistence.integration` | Įrašius token'ą į cookie kaip `session.id` arba `token_hash` → krinta trijų reikšmių atskyrimo tikrinimas; įrašius plikąjį token'ą į lentelę → krinta pilnos eilutės (`to_jsonb`) patikra |
| `token_hash` yra SHA-256 lowercase hex, deterministinis ir greitas (lėtas KDF = DoS) | `sessionTokenHash` | Pakeitus helperį į `scryptSync` → krinta determinizmas (atsitiktinė druska), formatas (128 vs 64 hex) ir 1000 maišų < 100 ms riba |
| Bearer token'as lieka ≥ 256 bitų `randomBytes`; `uuid` formos token'as atmetamas | `sessionTokenHash` | Grąžinus `session.id` kaip token'ą → krinta entropijos ir uuid formos patikros |
| Autentikacija ir `touch` yra VIENA sąlyginė operacija (nėra revokacijos TOCTOU) | `sessionPersistence.integration`, `sessionTokenHash` | Įvedus `findByToken()` → `touch()` seką → užklausų skaitiklis ties draiverio riba rodo 2, ne 1; `findByToken` buvimo sargas krinta visuose trijuose moduliuose |
| Idle IR absoliutus langai lieka ATSKIRI; `touch` pratęsia tik idle | `sessionStoreBackendContract.integration`, `authFoundation` | Palikus vieną `expires_at` → krinta `idle-langas`; pratęsus absoliutų → krinta `touch-pratesia-tik-idle` |
| Sesijų saugyklos gedimas → 503 `SESSION_STORE_UNAVAILABLE`, NE 401 ir NE anoniminis vykdymas | `sessionAuthFailClosed.route` | Pridėjus `catch { return null; }` → `requireSession` grąžina 401, `optionalSession` tęsia anonimiškai, `authenticate` krenta į `API_KEY` šaką → krinta trys testai |
| Login yra fail-closed: DB klaida → nėra `Set-Cookie`, auditas žymi nesėkmę | `sessionAuthFailClosed.route` | Perkėlus `setSessionCookie()` prieš patvirtintą `create()` → atsakyme atsiranda cookie ir krinta patikra |
| Atsijungimas su kritusiu auditu: revokacija ĮVYKO → cookie išvaloma IR grąžinamas 503 (visos trys būsenos sutampa); revokacija NEĮVYKO → cookie lieka | `auditBlockingRoutes.route` | Perkėlus cookie valymą po audito → klientas lieka su negaliojančiu cookie; valant visada → krinta komplementarus testas, nes sesija dar galioja |
| Atsijungimas revokuoja: ta pati cookie NEBEAUTENTIFIKUOJA (globaliai) | `sessionAuthFailClosed.route`, `sessionPersistence.integration` | Palikus `destroy(sessionId)` semantiką → revokacija neranda eilutės ir cookie lieka galiojanti; revokacija tik proceso atmintyje → antras pool'as sesiją vis dar priima |
| Startinis `AUTH_USERS` suderinimas yra READINESS BARJERAS prieš `listen()` | `startupOrder`, `sessionPersistence.integration` | Perkėlus suderinimą į foną arba po `listen` → krinta `deepEqual` tvarkos patikra; suderinimo klaida be `listen` blokavimo → krinta antrasis testas |
| `AUTH_USERS` tikrinamas KIEKVIENO `touch()` metu, ne tik starte: procese, turinčiame naują konfigūraciją, pašalintas ar pažemintas vartotojas sesijos nebeautorizuoja (aplinkos pakeitimas vis tiek reikalauja restarto) | `sessionAuthFailClosed.route`, `sessionStoreBackendContract.integration` | Pašalinus `patikrintiTapatybe()` iš `touch()` → sena rolė toliau autorizuoja; įrašas nebepažymimas revokuotu |
| Retencija: revokuota sesija saugoma iki `expires_at`; valymas idempotentiškas | `sessionStoreBackendContract.integration` | Pakeitus į `DELETE WHERE revoked_at IS NOT NULL` → krinta „revokuota, bet nepasibaigusi NEŠALINAMA" scenarijus |
| Keturi `sessions` laiko invariantai galioja DB lygiu, o jų sąrašas pilnas | `sessionPersistence.integration`, `migrations.integration` | Pašalinus `CHECK` migracijoje → pažeidžianti eilutė įrašoma; palikus sąraše mažiau nei schemoje → `deepEqual` pilnumo patikra krinta |
| `SESSION_STORE_BACKEND` eksplicitinis; vien `DATABASE_URL` autentikacijos režimo nekeičia | `sessionAuthFailClosed.route` | Perjungus parinkimą į `DATABASE_URL` buvimą → krinta jungiklio testas; nuėmus `startupChecks` patikrą → nežinoma reikšmė praeina startą |
| `/api/ready` atspindi GYVĄ sesijų autoriteto būseną, ne starto vėliavą; fail-closed ir su baigtine riba | `sessionAuthFailClosed.route` | Pašalinus `sessionStoreReachable` iš `ready` sprendimo → krinta 4 readiness testai; `await store.probe(); return true` (neignoruojant grąžintos reikšmės) → krinta „zondas, grąžinęs `false`" testas |
| Ištuštinus `AUTH_USERS`, sesija su stabiliu `userId` revokuojama ABIEJUOSE backend'uose | `sessionStoreBackendContract.integration`, `sessionAuthFailClosed.route` | Grąžinus sąlygą `Boolean(env.AUTH_USERS.trim())` į tapatybės patikrą → krinta bendras scenarijus `auth-users-istustintas` ir fasado testas |
| Memory ir PostgreSQL vykdo TĄ PATĮ scenarijų rinkinį | `sessionStoreBackendContract.integration` | Backend'ų semantikai išsiskyrus (pvz. fizinis vs loginis šalinimas) → krinta atitinkamas bendras scenarijus; pašalinus scenarijų → krinta pilnumo patikra pagal `id` |

### #210 — audito fasado async cutover (#155, 7.4a)

⚠️ **DU TERMINAI, KURIE NĖRA SINONIMAI.** Skaitant šią lentelę:

- **`BLOKUOJANTIS`** — „sėkmė NEDEKLARUOJAMA be patvirtinto audito įrašo".
  Galioja visiems blokuojantiems įvykiams.
- **`fail-closed`** — „veiksmas ATMETAMAS", t. y. apskritai neįvyksta.
  Galioja tik ten, kur auditas rašomas PRIEŠ veiksmą (autentikacija,
  autorizacija).

Keturiems ištrynimo įvykiams galioja tik pirmasis — žr. „RIBA" eilutę žemiau.
Autoritetas kode: `utils/auditEvents.js` `POST_HOC_IVYKIAI`.

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| Kiekvienas žinomas audito įvykis turi VIENĄ autoritetingą klasifikaciją (blokuojantis / neblokuojantis); trečios kategorijos nėra | `auditAsyncCutover` | Pridėjus `normalizeEvent()` šaką ar `event:` literalą be įrašo `utils/auditEvents.js` → krinta išvedimo ir tripwire testai; `default: "non-blocking"` → krinta neklasifikuoto įvykio testas |
| Neklasifikuotas įvykis aptinkamas PALEIDIMO metu, ne pirmo įvykio metu | `auditAsyncCutover` | Pašalinus `validateAuditEvents()` iš `startupChecks` → startas nebepraneša apie neklasifikuotą `normalizeEvent()` išvestį |
| Blokuojantis audito gedimas ATMETA saugomą veiksmą (fail-closed) | `auditAsyncCutover`, `auditBlockingRoutes.route` | Pakeitus `LOGIN_SUCCESS` į neblokuojantį → prisijungimas grąžina 200 be audito įrašo; pašalinus `await` maršrute → cookie išduodama nepatvirtinus audito |
| Sėkmė nedeklaruojama anksčiau už auditą: `Set-Cookie` siunčiama TIK po patvirtinto įrašo | `auditBlockingRoutes.route` | Grąžinus `setSessionCookie()` prieš `rasytiAudita()` → krinta „sesijos cookie negali būti išduota" |
| Neblokuojantis gedimas operacijos NEKEIČIA (tikslus statusas ir turinys sutampa su atsakymu prieš gedimą), bet didina skaitiklį ir loguojamas `error` lygiu | `auditAsyncCutover`, `auditBlockingRoutes.route` | Nutylėjus rejection → skaitiklis lieka 0; pakeitus įkėlimo atmetimą iš 400 į 403 → krinta tikslaus sutapimo patikra |
| Skaitiklis nedvigubinamas: viena klaida per TIKRĄ produkcinį helperį (`recordRejectedUpload`) = vienas inkrementas, o blokuojantis gedimas jo NEDIDINA | `auditAsyncCutover` | Pridėjus antrą inkrementą į `recordRejectedUpload()` → krinta; pridėjus inkrementą į blokuojančią `rasytiAudita()` šaką → krinta komplementarus testas |
| Audito rašymas turi BAIGTINĘ ribą (`AUDIT_WRITE_TIMEOUT_MS`, numatyta 2000) abiejose kategorijose | `auditAsyncCutover`, `auditBlockingRoutes.route` | Pašalinus `suRiba()` → kabantis backend'as užstoja užklausą; `unref()` ant laikmačio → procesas išsenka nesulaukęs timeout |
| Blokuojantys helperiai (`authorizeJobOrAudit`, `lifecycleService.writeAudit`) NEIŠSISPRENDŽIA anksčiau nei patvirtintas audito įrašas | `auditAsyncCutover` | Pašalinus `await` VIDUJE helperio → atidėto backend'o testas rodo, kad sprendimas grąžintas per anksti, o fail-closed testas — kad klaida nebepropaguojama |
| GDPR ištrynimo keliai (`DATA_ERASED`, `LIFECYCLE_DELETION`, `RETENTION_PURGE`) NENURYJA audito klaidos — sėkmė NEDEKLARUOJAMA be patvirtinto įrašo (`DELETE` grąžina 503, ne 204) | `auditAsyncCutover`, `jobErasure` | Grąžinus `catch {}` aplink auditą → ištrynimas praneša sėkmę be patvirtinto įrašo; testas izoliuoja įvykį, kad atmetimą duotų būtent tikrinamas kelias |
| ⚠️ **RIBA:** šie keturi (+ `ADMIN_ORPHAN_CLEANUP`) yra **post-hoc pagal konstrukciją** — auditas rašomas JAU PO trynimo, tad gedimas apsaugo **ataskaitą, ne duomenis**. `BLOKUOJANTIS` čia reiškia „sėkmė nedeklaruojama", NE „veiksmas atmetamas". Perrikiavimas atidėtas į [7.4b] (persistentis `audit_log`, `AUDIT_ID_SALT`) ir [7.5b] („AUDITO RAŠYMO KLAIDOS NEPRARANDAMOS") | `auditAsyncCutover` | Pašalinus įvykį iš `POST_HOC_IVYKIAI` arba pakeitus jo kategoriją → krinta post-hoc aibės ir kategorijos patikra |
| Inline vykdymas: audito gedimas autorizacijoje perkelia job'ą į TERMINALIĄ būseną (`AUDIT_UNAVAILABLE`), o ne palieka pakibusį | `auditAsyncCutover` | Pašalinus `try/catch` aplink `authorizeJobOrAudit()` → `_runInline` atmeta, job'as lieka neterminalus, `setImmediate` paleidėjas duoda `unhandledRejection` |
| VISI DELETE keliai — ir administraciniai, ir SAVININKO — audito gedimą grąžina kaip sanitizuotą `503 AUDIT_WRITE_FAILED`, ne Express numatytąjį 500 | `auditBlockingRoutes.route` | Pašalinus `auditoGedimas()` iš `routes/jobs.js` šakų → atsakymas tampa 500, o ne produkcijoje į jį patenka pirminė klaida |
| Inline ir BullMQ keliai audito gedimą baigia VIENODAI (`AUDIT_UNAVAILABLE`), nepriklausomai nuo to, ar sukonfigūruotas Redis | `auditAsyncCutover` | Pašalinus `try/catch` iš `workers/index.js` → klaida keliauja į BullMQ retry ir baigiasi `internal_error`, t. y. kita išoriškai matoma priežastis |
| Per KONSTANTĄ nurodomi įvykiai (`ADMIN_EVENT.*`) tikrinami STARTE, o neišspręstas konstantos šaltinis yra klaida, ne tylus praleidimas | `auditAsyncCutover` | Pakeitus `ADMIN_EVENT` reikšmę į neklasifikuotą → `validateConfig()` grąžina klaidą |
| Po timeout ĮSIRAŠĘS blokuojantis įvykis tampa randamas (`error` logas + skaitiklis), nes `Promise.race` rašymo nenutraukia | `auditAsyncCutover` | Pašalinus vėluojančios sėkmės apdorojimą → įrašas atsiranda tyliai, o kvietėjui pasakyta, kad nepavyko |
| Neklasifikuotas PRODUKCINIS `event:` literalas sustabdo STARTĄ (ne tik CI tripwire) | `auditAsyncCutover` | Pakeitus bet kurį call site'o įvykį į neklasifikuotą → `startupChecks.validateConfig()` grąžina klaidą; skeneris nuvalo komentarus, kad nepagautų savo dokumentacijos |
| Prisijungimo audito gedimas ATŠAUKIA jau sukurtą sesiją (jokių našlaičių be savininko) | `auditBlockingRoutes.route` | Pašalinus `sessionStore.destroy()` iš audito gedimo šakos → perimtas token'as vis dar autentifikuoja, nors klientas jo negavo |
| ⚠️ `PRIVACY_MODE=true` yra EKSPLICITINĖ blokuojančios garantijos išimtis: įrašo nėra, veiksmas tęsiamas, režimas fiksuojamas `warn` lygiu | `auditAsyncCutover` | Nutylėjus režimą (be `warn`) → krinta; padidinus skaitiklį → krinta, nes tai konfigūracija, ne gedimas |
| Rašymo mechanizmas `rasytiAudita()` nepalieka nesuvaldyto Promise NĖ VIENAME iš trijų gedimo režimų (blokuojantis + backend klaida, neblokuojantis + backend klaida, timeout abiejuose) | `auditAsyncCutover` | Pašalinus `await` mechanizme → registruotas `process.on("unhandledRejection")` suveikia |
| ⚠️ **RIBA: detektorius apginkluotas NE visuose call site'uose.** `process.on("unhandledRejection")` realiai supa rašymo mechanizmą ir keturis produkcinius kelius: `authorizeJobOrAudit()`, `lifecycleService.deleteJobArtefacts()`, `_runInline` ir HTTP `DELETE`/`logout` maršrutus. Likusius call site'us dengia TIK statinis tripwire (`void` / `.catch(() => {})` / `try{}catch{}` aplink auditą nebuvimas), kuris pagal AGENTS.md §9.2 yra tripwire, o **ne elgsenos įrodymas** | `auditAsyncCutover`, `auditBlockingRoutes.route` | Detektorių dengiamuose keliuose: pašalinus `await` → suveikia. Kituose: pridėjus `void` prieš audito kvietimą → krinta statinė patikra, bet ne elgsenos testas |
| Vėluojanti backend klaida PO timeout nesukelia `unhandledRejection` (o vėluojanti SĖKMĖ tampa matoma `error` lygiu) | `auditAsyncCutover` | Pašalinus vėlyvo atmetimo/sėkmės apdorojimą `suRiba()` → suveikia detektorius arba dingsta `error` įrašas |
| Gyvavimo ciklo ištrynimo žyma NEPATVIRTINAMA (`deleted`) anksčiau nei patvirtintas auditas — kritęs auditas palieka `deletion_pending`, o pakartotinis kvietimas realiai užfiksuoja įvykį, o ne grąžina `already_deleted` | `auditAsyncCutover` | Sukeitus `tombstones.complete()` ir `await writeAudit()` vietomis → antras kvietimas trumpina kelią, `LIFECYCLE_DELETION` dingsta NEGRĮŽTAMAI (žyma `deleted` yra galutinė), o kvietėjas mato sėkmę |
| NE audito klaida autorizacijoje (nepalaikoma `schemaVersion`, nežinomas `actorSource`) NEVADINAMA `AUDIT_UNAVAILABLE` — job'as vis tiek tampa terminalus, bet su `AUTHORIZATION_ERROR` | `auditAsyncCutover` | Grąžinus vieną `error_code` visoms klaidoms → schemos nesuderinamumas pasirodo kaip audito infrastruktūros gedimas ir tikroji priežastis pasislepia |
| Terminalus audito gedimas autorizacijoje ATLAISVINA įkeltą šaltinio audio (`releaseAudio`) | `auditAsyncCutover` | Pašalinus valymą iš audito gedimo šakos → failas lieka saugykloje neribotai: retencijos valytojas jo neliečia, nes raktą vis dar nurodo gyvas job'o įrašas |
| Kiekviena nutraukimo šaka daro LYGIAI VIENĄ terminalų perėjimą — antras `finish()` jau terminaliam job'ui state machine atmetamas, klaida iškiltų PRIEŠ valymą ir `return`, grįžtų į BullMQ pakartojimus, o šaltinio audio liktų susietas | `workerAuthorization` | Pridėjus antrą `system.finish()` bet kurioje nutraukimo šakoje → krinta prie šakos anksčiuota patikra (patikrinta abiejuose failuose) |
| VIENAS audito rašymo bandymas → NE DAUGIAU KAIP VIENAS `auditWriteFailures` didinimas. Neblokuojančiame kelyje didina timeout politika, blokuojančiame — vėluojanti sėkmė; abu vienu metu niekada | `auditAsyncCutover` | Padarius vėlyvos sėkmės didinimą besąlyginį → vienas lėtas `EXPORT_*` rašymas praneša du gedimus; pašalinus jį visai → dingsta blokuojančio neatitikimo matomumas (krinta abu testai) |
| **Gretima pataisa (ne #210 apimtis):** ir ATŠAUKTŲ TEISIŲ nutraukimas (`AUTHORIZATION_REVOKED`) atlaisvina šaltinio audio — anksčiau ta šaka grįždavo be valymo, nors gretima audito gedimo šaka valo. Iš išorės matoma baigtis nesikeičia (ta pati galutinė nesėkmė), suvienodinamas tik resursų valymas | `auditAsyncCutover` (inline elgsena), `workerAuthorization` (abiejų kelių paritetas) | Pašalinus valymą iš bet kurios iš trijų nutraukimo šakų → krinta: inline elgsenos testas arba prie konkrečios šakos anksčiuota pariteto patikra |
| ⚠️ **RIBA:** BullMQ (`workers/index.js`) nutraukimo šakų ELGSENA šioje aplinkoje nepatikrinta — jai reikia Redis. Ją dengia tik pariteto tripwire, anksčiuotas nuo šakos `error_code` iki jos `return` (AGENTS.md §9.2: tripwire, ne elgsenos įrodymas) | `workerAuthorization` | Pirmoji tripwire versija skaičiavo `_cleanupStorage` kiekį faile ir mutacijos NEPAGAVO — įprasti keliai valymą kviečia savaime; anksčiavimas prie konkrečios šakos tai ištaisė |
| Eksplicitinis įvykio vardas, neatitinkantis `EVENT_PATTERN` — įskaitant `null`, skaičių, objektą, masyvą ar loginę reikšmę iš dinaminio šaltinio — ATMETAMAS kaip `AUDIT_EVENT_MALFORMED`. Nepateiktu laikomas TIK realiai praleistas (`undefined`), tad išvedimas iš kitų laukų lieka veikti | `auditAsyncCutover` | Susiaurinus sargybą iki `typeof === "string"` → `null`/skaičius/objektas vėl išvedami į `PROCESSING_COMPLETED` ir autentikacijos įvykis paveldi NEBLOKUOJANČIĄ semantiką |
| Matricos lentelių VIENTISUMAS: kiekvienos eilutės langelių skaičius atitinka jos antraštę — praleistas eilutės lūžis sujungtų dvi eilutes per `\|\|`, ir antroji garantija iš autoritetinio sąrašo dingtų TYLIAI | `npm run test:matrix` | Sujungus bet kurias dvi eilutes → `check-security-matrix.mjs` grąžina klaidą su eilutės numeriu. Patikra iškart rado ir jau egzistavusią tokią klaidą nuo `f6a8af0` (#154) |
| Klaidos žinutėje ir loge rodomas netinkamos reikšmės TIPAS, ne pati reikšmė | `auditAsyncCutover` | Grąžinus `JSON.stringify(vardas)` → ciklinis objektas KRISTŲ klaidos konstruktoriuje vietoj to, kad praneštų problemą, o dinaminio šaltinio duomenys patektų į logą |
| `POST_HOC_IVYKIAI` apima ir `LOGOUT` (sesija atšaukta ir cookie išvalytas prieš įrašą) bei `ADMIN_DELETE_OVERRIDE` (artefaktai jau pašalinti) — abu lieka blokuojantys, bet NĖRA fail-closed | `auditAsyncCutover` | Pašalinus juos iš aibės → krinta tiksli post-hoc aibės patikra, o dokumentacija imtų teigti „veiksmas atmetamas" ten, kur jis jau negrįžtamai įvykęs |
| Backend'o klaidos tekstas NEPATENKA į HTTP atsakymą (sanitizacija per `utils/sanitizeError.js`) | `auditBlockingRoutes.route` | Grąžinus `error.message` klientui → sentinel su `host=`, `user=`, `password=` randamas atsakyme |

### #211 — persistentinis audito žurnalas (#155, 7.4b)

⚠️ **AKIVAIZDUMO RIBA.** Dalis šių garantijų reikalauja TIKROS PostgreSQL: jos
įgyvendintos ir padengtos testais, bet vietinėje aplinkoje NEBUVO ĮVYKDYTOS
(nėra egzemplioriaus; provizionavimas eksplicitiškai uždraustas). Tokios
eilutės pažymėtos **[NOT RUN]** ir nėra `PASS` iki CI įrodymo (AGENTS.md §14).

| Garantija | Testai | Mutacijos įrodymas |
|---|---|---|
| `AUDIT_BACKEND` yra TREČIAS nepriklausomas jungiklis: nei `JOB_STORE_BACKEND`, nei `SESSION_STORE_BACKEND`, nei vien `DATABASE_URL` audito režimo nekeičia | `auditStoreFields`, `startupChecks` | Numatytąja reikšme padarius `postgres`, kai yra `DATABASE_URL` → auditas persistintų be sprendimo; krinta jungiklio testai |
| Nežinoma `AUDIT_BACKEND` reikšmė ir `postgres` be `DATABASE_URL` NUTRAUKIA startą, o ne tyliai virsta atmintimi | `startupChecks` | Pakeitus `throw` į `return "memory"` → operatorius gauna veikiantį servisą su dingstančiu žurnalu |
| `AUDIT_BACKEND=postgres` be `AUDIT_ID_SALT` NEPAKYLA — atsitiktinė druska padarytų GDPR ištrynimą neveiksmingą po restarto | `startupChecks`, `auditPersistence.integration` **[NOT RUN]** | Leidus atsitiktinį fallback → `removeBySubjectIdentifier()` senų įrašų neberastų ir grąžintų „ištrinta 0" |
| `AUDIT_ID_SALT_ID` privaloma; `hash_key_id` yra operatoriaus etiketė, NEIŠVESTA iš druskos | `auditPersistence.integration` **[NOT RUN]** | Išvedus etiketę iš druskos → ji taptų orakulu druskos spėjimams tikrinti |
| `PRIVACY_MODE=true` × `postgres` NUTRAUKIA startą (prieštaringas derinys) | `startupChecks` | Leidus derinį → migruota, sukonfigūruota ir amžinai tuščia lentelė atrodytų kaip veikianti sistema |
| Audito saugykla inicijuojama PRIEŠ `listen()`, o jos klaida reiškia, kad `listen` NEKVIEČIAMAS | `startupOrder` | Perkėlus `auditStore.init()` po `listen` arba pagavus jo klaidą → krinta tvarkos `deepEqual` ir fail-closed testas |
| Vienas laukų skirstymo autoritetas: `fields.js` sąrašai TIKSLIAI atitinka `record()` išvestį | `auditStoreFields` | Pridėjus lauką į `record()` ir ne į `fields.js` → krinta paritetas (kitaip laukas tyliai nebūtų saugomas) |
| `meta` allowlist yra SAUGYKLOS RIBOS garantija ABIEJUOSE backend'uose — nežinomas laukas nutylimas | `auditStoreFields`, `auditStoreBackendContract.integration` (memory + pg) | Pašalinus `normalizuoti()` iš memory šakos → `transcript` ir plikas `jobId` išliktų ir grįžtų per `/api/audit`; krinta bendras kontraktas |
| Riba (`LIMIT`) ir esami filtrai (`event`, `request_id`) taikomi SAUGYKLOJE, ne po atsiėmimo | `auditStoreBackendContract.integration` | Grąžinus `.slice()` Node'e → krinta `total` semantika; palikus filtrus Node'e su SQL riba → filtruojamas PUSLAPIS, ne aibė |
| Determinuota skaitymo tvarka: VIENOJE TRANSAKCIJOJE įrašytos eilutės skaitomos įrašymo tvarka (`seq`, ne `timestamp`, ne `id`) | `auditStoreBackendContract.integration` (pg adapteris) **[NOT RUN]** | Pakeitus `ORDER BY seq` į `ORDER BY timestamp` → `now()` vienoje transakcijoje duoda vienodus laikus ir tvarka tampa neapibrėžta |
| Rašymas idempotentiškas pagal `id` (at-least-once, be bendros transakcijos su job saugykla) | `auditStoreBackendContract.integration` (memory + pg) | Pašalinus `ON CONFLICT` arba memory `find()` → pakartojimas po timeout sukurtų antrą eilutę; divergenciją rado bendras kontraktas |
| `timestamp` autoritetas yra DB (`DEFAULT now()`); aplikacijos laikas į lentelę nepatenka | `auditPersistence.integration` **[NOT RUN]** | Perdavus `timestamp` iš aplikacijos → sugedęs NTP vienoje replikoje sumaišytų viso audito tvarką |
| APPEND-ONLY: tiesioginis SQL `UPDATE` atmetamas trigerio, įskaitant `meta` keitimą | `auditPersistence.integration` **[NOT RUN]** | Pašalinus trigerį → įrašą apie neteisėtą veiksmą galima pataisyti per `psql` |
| Nukritęs append-only trigeris NUTRAUKIA startą (jis NĖRA `CHECK`, tad `REQUIRED_AUDIT_CONSTRAINTS` jo nemato) | `auditPersistence.integration` **[NOT RUN]** | Pašalinus atskirą trigerio patikrą → DB su nukritusiu trigeriu startuotų sėkmingai, o auditas taptų redaguojamas |
| `DELETE` DB lygmenyje NERIBOJAMAS — sąmoningas sprendimas, be jo GDPR ištrynimas neįmanomas | `auditPersistence.integration` **[NOT RUN]** | Atėmus `DELETE` grantą → `removeBySubjectIdentifier()` nustotų veikti |
| `REQUIRED_AUDIT_CONSTRAINTS` sąrašas PILNAS — išvedamas iš šviežiai migruotos DB, ne surašomas ranka | `auditPersistence.integration` **[NOT RUN]** | Pridėjus `CHECK` migracijoje ir ne į sąrašą → starto barjeras praleistų DB be to invarianto |
| Neleistina `result` ir neatitinkantis `event` atmetami CHECK invariantų; DB šablonas SUTAMPA su runtime `EVENT_PATTERN` | `auditPersistence.integration` **[NOT RUN]**, `auditStoreFields` (tripwire) | Įrašius šabloną migracijoje literalu → du autoritetai išsiskirtų tyliai, ir runtime priimtų įvykį, kurio DB nebepriima |
| RAW: plikojo job ID NĖRA nė viename stulpelyje ar `meta` lauke (`to_jsonb(t)` visai eilutei, per PRODUKCINĮ kelią) | `auditPersistence.integration` **[NOT RUN]** | Įrašius `jobId` vietoj `subjectId` → sentinel randamas RAW eilutėje |
| RAW: transkripcijos ir prompt'o turinio nėra net tada, kai jis perduodamas TYČIA | `auditPersistence.integration` **[NOT RUN]** | Pašalinus allowlist → sentinel patenka į `meta` JSONB |
| Auditas išlieka po instancijos sunaikinimo; dvi instancijos toje pačioje DB mato viena kitos įrašus ir ištrynimus | `auditPersistence.integration` **[NOT RUN]** | Tai neįmanoma atmintyje iš principo - būtent dėl to 7.4b ir egzistuoja |
| Pool'o gyvavimo ciklas: `shutdown()` uždaro jungtis, ir DB pusėje (`pg_stat_activity`) jų nelieka | `auditPersistence.integration` **[NOT RUN]** | Pašalinus `pool.end()` → po kelių restartų išnaudojamas `max_connections` |
| Laiko biudžetas: `statement_timeout` (0.7×T) + pool riba (0.2×T) TELPA į `AUDIT_WRITE_TIMEOUT_MS`, ir DB realiai NUTRAUKIA ilgą užklausą | `auditPersistence.integration` **[NOT RUN]**, `startupChecks` (invariantas) | Sulyginus `statement_timeout` su fasado langu → fasadas visada suveiktų pirmas, DB nespėtų nutraukti, ir vėlyvas rašymas taptų neišvengiamas |
| Išsekęs pool'as duoda klaidą per ribotą laiką, o ne kabo neribotai | `auditPersistence.integration` **[NOT RUN]** | Pašalinus `connectionTimeoutMillis` → užklausa liktų eilėje ir įsirašytų JAU PO to, kai kvietėjui pasakyta „nepavyko" |
| Produkcinis kelias su TIKRA DB klaida nesukelia `unhandledRejection`; blokuojantis įvykis atmeta veiksmą, neblokuojantis - ne | `auditPersistence.integration` **[NOT RUN]** | Pašalinus `await` → detektorius suveikia (atmintyje ši šaka realiai nebuvo vykdoma, nes `record()` nekrisdavo) |
| `audit_log` NEĮTRAUKIAMAS į atkūrimą — GDPR ištrinti įrašai negrįžta | `backupRestore` (esamas, 7.4a) | Atkūrus `parsed.audit` → ištrintas įrašas grįžta; testas jau egzistuoja |
| ⚠️ **RIBA:** retencija (`AUDIT_RETENTION_DAYS`, `AUDIT_MAX_ENTRIES`) galioja TIK `memory` režimui. `postgres` režime įrašai automatiškai NEŠALINAMI — savininkas [7.4d] | `docs/audit-storage.md` §9 | Skirtumas dokumentuojamas, o ne slepiamas: teiginys „retencija veikia visur" būtų stipresnis už kodą (AGENTS.md §12.1) |
| ⚠️ **RIBA:** `POST_HOC_IVYKIAI` NETAMPA fail-closed 7.4b metu. Patvarumas ≠ perrikiavimas; kompensacinis mechanizmas yra [7.5b] | `auditAsyncCutover` (post-hoc aibė), `docs/audit-storage.md` §12 | Pagrindimas užrašytas `auditEvents.js` komentare ir dokumentacijoje, ne issue komentare |
