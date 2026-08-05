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

## Redis ir persistencija

| Garantija | Testai | Pastaba |
|---|---|---|
| Restart ir stalled recovery | `queueRecovery.integration` | Reikia tikro Redis |
| Worker heartbeat → readiness | `heartbeatReadiness.integration` | Reikia tikro Redis |
| Koreliacija išgyvena saugyklos ratą | `redisConcurrency.integration` | `null` round-trip mutacija |
| Ištrynimas **išgyvena restartą** | `redisConcurrency.integration` | `remove()` no-op → krinta 2 |

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
