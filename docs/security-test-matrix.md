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
