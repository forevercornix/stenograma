# 0001 — Stabilus vartotojo identitetas `AUTH_USERS` ketvirtame lauke

**Statusas:** Priimtas · **Issue:** #158 (#152 dalis) · **Data:** 2026-08

## Kontekstas

`req.user` turėjo tik `{ username, role }`. Stabilaus identifikatoriaus nebuvo, o
`username` netinka kaip tapatybės raktas: jis gali pasikeisti ir yra prastas užsienio raktas.

Pasekmė buvo matoma jau kode: `utils/jobAuthorization.js` perskaičiuoja rolę vykdymo metu
ir ieško aktoriaus **pagal vardą**, todėl pervadinimas grąžindavo `ACTOR_UNKNOWN` ir
nutraukdavo eilėje laukiantį darbą, nors tapatybė nepasikeitė.

Sprendimas skubus todėl, kad nuo jo priklauso #159 (`jobs.owner_id`) ir #155 PostgreSQL
schema (`jobs.owner_id`, `audit_log.owner_id`). Schema, sukurta be stabilaus ID, vėliau
reikalautų duomenų migracijos, ne stulpelio pridėjimo.

## Sprendimas

**1. `userId` yra UUIDv4, stabilus, nederivuojamas iš `username`.**

**2. `AUTH_USERS` pereina prie tikslaus keturių laukų kontrakto:**

```
vardas:rolė:scrypt$N$r$p$saltHex$hashHex:userId
```

`AUTH_USERS` lieka **vienintelis** identity provisioning šaltinis. `users` lentelė ir
persistentinės sesijos nekuriamos — tai #155 / 7.3.

**3. Parseris nustoja godžiai rinkti maišos uodegą.** Ankstesnis
`const [username, role, ...hashParts] = parts` buvo suderinamumo atsarga tam atvejui, jei
maišoje atsirastų dvitaškis. Realiai scrypt serializacija dvitaškių nenaudoja, o
`parseStoredHash()` tai griežtai validuoja. Godumas dabar tik kenktų: ketvirtas laukas
tyliai priliptų prie maišos, o klaida pasirodytų kaip klaidinantis „netinkamas scrypt
formatas". Kontraktą saugo testas „maiša su dvitaškiu → klaida".

**4. UUID formos vardas draudžiamas.** `USERNAME_PATTERN` tokį vardą įleistų
(`a1b2c3d4-e29b-41d4-a716-446655440000` prasideda raide, turi tik `[a-z0-9-]`, 36 simboliai).
Maršrutizavimas nuo formos nepriklauso, bet vardas, neatskiriamas nuo ID, klaidintų logus
ir auditą. Tai defense-in-depth, ne funkcinė būtinybė.

**5. Job'ai skiriami pagal ĮRAŠO ERĄ, ne pagal aktoriaus eilutės formą.**

Nauji job'ai žymimi `schemaVersion: 2`. Pre-v2 įrašų semantika išlaikoma pagal jų esamą
`actorSource` — repo turi **tris** skirtingas eras, ne dvi:

| `schemaVersion` | `actorSource` | Era | Elgesys |
|---|---|---|---|
| nėra | nėra | #17 | `NO_ACTOR` passthrough (leidžiama; teisę patikrino HTTP sluoksnis kūrimo metu) |
| nėra | `session` | #18 | legacy username lookup |
| nėra | `api-key` | #18 | `resolveApiKeyRole` |
| `2` | `session` | #158 | ID lookup pagal `userId` |
| `2` | `api-key` | #158 | `resolveApiKeyRole` |

**Nei viena legacy era šiame issue automatiškai nemigruojama.** Įrašai natūraliai išnyksta
per TTL / retenciją; legacy šakos šalinamos atskiru PR po to lango.

Trijų erų atskyrimas nėra teorinis: `utils/jobAuthorization.js` dokumentuoja, kad #17 laikų
job'ai turėjo `actor` be `actorSource`, ir dėl to **0 iš 6 job'ų pasiekė procesorių**.
Klaida praslydo pro vienetinius testus ir buvo rasta tik CI su tikru Redis. Todėl trijų erų
scenarijus su realiu Redis yra 6 žingsnio priėmimo sąlyga, ne papildomas testas.

**Rašytojas ir skaitytojas — viename pakeitime.** `actor = userId` be kartu įdiegtos
ID paieškos nėra tarpinis žingsnis, o neveikianti sistema: kiekvienas sesijos job'as
kristų `ACTOR_UNKNOWN` iš karto. Tai patvirtinta praktiškai #158 metu, todėl planuota
5 ir 6 žingsnių riba buvo panaikinta ir abu įgyvendinti kartu.

Taisyklė galioja plačiau: **kai naujas duomenų kontraktas keičia lauko SEMANTIKĄ, jo
rašytojas ir skaitytojas turi būti merginami atomiškai.** Tai tiesiogiai taikoma #159
`ownerId` darbui.

## Atmestos alternatyvos

**`AUTH_USER_IDS=vardas=uuid,...` atskirame kintamajame.** Sukurtų antrą konfigūracijos
šaltinį, kurio nuoseklumą su `AUTH_USERS` reikėtų atskirai validuoti ir testuoti. Ketvirtas
laukas išlaiko vieną vartotojo provisioning įrašą kaip vieną atomą.

**UUID formos atpažinimas (`actor` atitinka UUID → naujas formatas).** Trapu ir dviprasmiška:
`USERNAME_PATTERN` UUID formos vardą įleidžia, o API rakto aktorius (`key_<hex>`) irgi nėra
UUID. Forma negali nulemti lookup kelio.

**Failure-based fallback (ID nerastas → bandyti pagal vardą).** Sujungtų du skirtingus
atvejus: teisėtai ištrinto vartotojo įvykiai užterštų WARN signalą, pagal kurį sprendžiama,
kada legacy šaką galima šalinti.

**`loadUsers()` grąžinimo tipo keitimas.** Ją naudoja `verifyCredentials()`,
`utils/jobAuthorization.js` ir `utils/startupChecks.js` — kontrakto keitimas paliestų tris
nesusijusius kelius. Vietoj to pridėta atskira `loadUsersById()`.

## Pasekmės

**Sąmoningas elgesio pokytis.** Authentication ir authorization politika nesikeičia,
išskyrus tai, kad nauji session job'ai tapatybę sprendžia pagal stabilų `user_id` —
todėl username pervadinimas nebeinvalidina eilėje laukiančių darbų. Tai pataisymas, ne
regresija, ir jis neturi būti vėliau „grąžintas atgal".

**Migracija reikalauja veiksmo prieš deploy.** Esami `AUTH_USERS` be ketvirto lauko
**stabdo serverio startą**. Tai atitinka jau galiojantį principą (netinkama maiša taip pat
stabdo startą): tyliai praleistas įrašas reikštų administratorių, manantį turintį veikiančią
paskyrą, kurios nėra. Automatinis UUID generavimas paleidimo metu būtų blogesnis — po
kiekvieno restarto ID skirtųsi, ir stabilaus identiteto garantija dingtų.

**`userId` keisti negalima.** Keičiant slaptažodį ar vardą, ketvirtas laukas paliekamas
tas pats; kitaip vartotojo job'ai ir audito įrašai atsies nuo jo paskyros. Todėl
`hash-password.js` turi eksplicitinį `--user-id` režimą: be jo skriptas sukuria naują
tapatybę ir tai garsiai pasako. Numatytasis administravimo įrankio elgesys neturi tyliai
pažeisti pagrindinės šio sprendimo garantijos.

**Sesijų revokacija ilgainiui pereina prie ID.** `destroyAllForUser(username)` lieka
suderinamumui, bet po pervadinimo revokacija pagal seną vardą tampa semantiškai neteisinga.
Adityviai pridėtas `destroyAllForUserId(userId)`; nauji tapatybe grįsti keliai renkasi jį.
Taip #155 / 7.3 sesijų perkėlimas į PostgreSQL jau turi teisingą revokacijos raktą.

**`userId` NEATSKLEIDŽIAMAS klientui.** `/api/auth/me` toliau grąžina `username`, `role` ir
`permissions`. Stabilus identifikatorius yra vidinis; jo perdavimas naršyklei būtų API
kontrakto pakeitimas be poreikio, ir kartą atskleistas jis taptų nebeatšaukiamas.

**Sesijos be `userId` galimos.** `userId: null` lieka teisėta reikšmė tapatybėms ne iš
`AUTH_USERS`. Todėl `destroyAllForUserId(null)` sąmoningai nieko netrina — kitaip
`null === null` sutaptų ir vienas kvietimas iškirstų visas tokias sesijas.

**`req.user.id === null` yra teisėtas — bet tik desktop/no-auth modelyje.** #159 tai
neturi interpretuoti kaip „visi null-owner job'ai priklauso tam pačiam vartotojui".
Autentifikuotame user-facing kelyje job'o kūrimas su netikėtai trūkstamu stabiliu ID
turi būti klaida; `ownerId = null` lieka tik sąmoningam desktop režimui ir legacy
politikai. Tai nuosavybės kontrakto klausimas, sprendžiamas #159.

**Ko šis sprendimas neapima:** nuosavybės (`ownerId`) — tai #159; HTTP autorizacijos
semantikos ir legacy job'ų politikos — tai #160.
