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
