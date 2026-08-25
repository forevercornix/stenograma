# Autentifikacijos ir prieigos kontrolės diegimas

Šis dokumentas yra GDPR issue #18 rezultatas. Jis skirtas tam, kas **diegia**
sistemą – ne tam, kas ją rašo.

---

## 1. Bootstrap: pirmas administratorius

Vartotojai konfigūruojami per `AUTH_USERS` aplinkos kintamąjį. Registracijos
srauto **nėra** – tai sąmoningas pilotinis apribojimas.

```bash
cd backend
node scripts/hash-password.js sysadmin administrator
# Slaptažodis: (įvedamas interaktyviai, nepatenka į shell istoriją)
```

Rezultatą įrašykite į `.env`:

```bash
AUTH_USERS=sysadmin:administrator:scrypt$16384$8$1$<druska>$<maiša>:<userId>
```

Kelis vartotojus atskirkite kableliais:

```bash
AUTH_USERS=sysadmin:administrator:scrypt$...:<uuid1>,darbuotojas:operator:scrypt$...:<uuid2>
```

⚠️ **`userId` (ketvirtas laukas) yra STABILI tapatybė.** Vardas gali keistis, ID – ne
(žr. [ADR 0001](decisions/0001-stable-user-identity.md)).

Naujam vartotojui ID sugeneruoja pats skriptas. **Esamam vartotojui** – keičiant
slaptažodį ar vardą – perduokite jo dabartinį ID, kitaip job'ai ir audito įrašai
atsies nuo paskyros:

```bash
# naujas vartotojas
node scripts/hash-password.js petras operator

# slaptažodžio ar vardo keitimas – ID IŠSAUGOMAS
node scripts/hash-password.js petras operator --user-id <esamas-uuid>
```

Esamą ID rasite dabartiniame `AUTH_USERS` įraše (ketvirtas laukas).

⚠️ **Slaptažodis niekada nelaikomas tekstu.** Netinkamai suformuota maiša
**stabdo serverio startą** – tai sąmoninga, nes tyliai praleistas įrašas
reikštų administratorių, manantį turintį veikiančią paskyrą, kurios nėra.

---

## 2. Rolės ir leidimai

| Leidimas | Ką leidžia | operator | administrator |
|---|---|:---:|:---:|
| `job:create` | Kurti transkribavimo/protokolo darbus | ✅ | ✅ |
| `job:read` | Skaityti darbo būseną ir rezultatą | ✅ | ✅ |
| `protocol:generate` | Generuoti protokolą | ✅ | ✅ |
| `export:redacted` | Eksportuoti redaguotą variantą | ✅ | ✅ |
| `job:delete` | **GDPR ištrynimas** (negrįžtama) | ❌ | ✅ |
| `export:original` | **Neredaguoti asmens duomenys** | ❌ | ✅ |
| `audit:read` | Audito žurnalas | ❌ | ✅ |

Žemėlapis gyvena `backend/utils/permissions.js` ir yra **deny-by-default**:
naujas leidimas be eksplicitinio priskyrimo yra uždaras.

---

## 3. Sesijų trukmė

| Nuostata | Numatyta | Ką reiškia |
|---|---|---|
| `SESSION_IDLE_TIMEOUT_MINUTES` | 30 | Neaktyvumo langas; kiekviena užklausa jį atnaujina |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | 12 | Maksimali sesijos trukmė **nepriklausomai nuo aktyvumo** |

Du limitai yra nepriklausomi. Absoliutus reikalingas todėl, kad vien idle
langas leistų sesijai gyventi neribotai, jei ji nuolat naudojama.

### Sesijų saugykla: atmintis arba PostgreSQL (#155, 7.3)

| Nuostata | Numatyta | Ką reiškia |
|---|---|---|
| `SESSION_STORE_BACKEND` | `memory` | `memory` arba `postgres`. Nežinoma reikšmė **stabdo startą**, ne virsta numatytąja |

⚠️ **Jungiklis EKSPLICITINIS.** Vien `DATABASE_URL` sesijų režimo **nekeičia** –
jis gali būti įvestas dėl migracijų ar audito, ir neturi netikėtai perjungti
autentifikacijos. `SESSION_STORE_BACKEND` yra **atskiras** nuo
`JOB_STORE_BACKEND`: job metaduomenų perkėlimas į PostgreSQL ir sesijų
persistencija yra du nesusiję sprendimai.

`SESSION_STORE_BACKEND=postgres` reikalauja `DATABASE_URL` ir paleistų
migracijų (`npm run migrate:up`). Trūkstama `sessions` lentelė arba trūkstamas
laiko invariantas **nutraukia startą** – grįžimo į atmintį nėra, nes jis tyliai
atimtų globalią revokaciją.

| | `memory` | `postgres` |
|---|---|---|
| Išgyvena restartą | ne | **taip** |
| Kelios replikos | ne | **taip** |
| Atsijungimas galioja kitame procese | ne | **taip** |
| Reikia `DATABASE_URL` | ne | **taip** |

**Paleidimo tvarka.** `sessionStore.init()`, schemos invariantų patikra ir
startinis `AUTH_USERS` suderinimas baigiami **prieš** `app.listen()`. Kol jie
nebaigti, kiekvienas sesiją liečiantis maršrutas grąžina `503`
`SESSION_STORE_UNAVAILABLE` – niekada `401`. Nepavykęs suderinimas reiškia, kad
serveris srauto **nepriima apskritai**.

⚠️ **Cutover: esamos sesijos NEPERKELIAMOS.** Perjungus į `postgres`, visi
prisijungia iš naujo. Atminties sesijos gyvena tik proceso viduje, tad jų
migracija būtų token'ų perrašymas be jokio saugumo pagrindo.

---

## 4. Revokacija

| Ką norite pasiekti | Ką daryti | Poveikis |
|---|---|---|
| Atjungti vieną seansą | Vartotojas spaudžia „Atsijungti" | Ta sesija nebegalioja iš karto – **ir visuose procesuose**, jei backend'as `postgres` |
| **Atimti prieigą visam laikui** | Pašalinti įrašą iš `AUTH_USERS` + restartas | Visos sesijos nebegalioja; **eilėje laukiantys darbai nutraukiami** |
| Sumažinti teises | Pakeisti rolę `AUTH_USERS` + restartas | Sesijos su senu rolės snapshot'u nutraukiamos; **eilėje laukiantys darbai su per aukšta teise nutraukiami** |

⚠️ **RESTARTAS TEBĖRA BŪTINAS, ir tai ne redakcinė smulkmena.** `AUTH_USERS`
skaitomas iš proceso aplinkos, o veikiančio proceso aplinkos kintamojo pakeisti
iš išorės negalima – konfigūracijos perkrovimo mechanizmo šis projektas neturi
(žr. 5 skyrių). Todėl operatoriaus procedūra yra ir lieka „pakeisti `AUTH_USERS`
+ perkrauti".

⚠️ **Ką 7.3 realiai pakeitė:** kiekvienas `touch()` tikrina `user_id` ir rolę
prieš **tuo metu galiojantį** `AUTH_USERS`, ne prieš sesijoje įrašytą
snapshot'ą. Nauda dvejopa:

- **nėra lango tarp starto ir suderinimo** – net jei sesija bandoma panaudoti
  anksčiau, nei baigtas startinis suderinimas, ji vis tiek tikrinama;
- **pasenusi rolė negali išgyventi** – persistentinė sesija po restarto neša
  seną rolės snapshot'ą, ir be šios patikros ji autorizuotų senomis teisėmis.

Startinis suderinimas papildomai revokuoja sesijas, kurių niekas nenaudojo tarp
konfigūracijos pakeitimo ir perkrovimo, kad jos nebūtų aptinkamos tik pirmo
panaudojimo metu.

⚠️ **Atšaukta sesija NEIŠTRINAMA iš karto.** Ji saugoma iki savo `expires_at`,
kad būtų galima atsakyti, ar cookie buvo **atšaukta**, ar jos **niekada
nebuvo**. Po `expires_at` retencija ją pašalina kartu su pasibaigusiomis.

**Asinchroniniai darbai:** teisės **perskaičiuojamos vykdymo metu**, ne
užšaldomos kuriant darbą. Jobai gali laukti eilėje valandas – per tą laiką
vartotojas gali būti pašalintas, ir būtent tada revokacija svarbiausia.

⚠️ **Atsijungimas darbo nenutraukia.** Sesija yra prisijungimo, ne teisės,
mechanizmas: vartotojas teisėtai pradėjo darbą ir uždaręs naršyklę jo
neatšaukė. Nutraukiama tik dingus pačiai tapatybei ar teisei.

---

## 5. Kredencialų rotacija

**Slaptažodžio keitimas:**

```bash
# 1. Nusikopijuokite esamą userId iš AUTH_USERS (ketvirtas laukas)
# 2. Sugeneruokite naują maišą IŠSAUGODAMI tą ID:
node scripts/hash-password.js <vardas> <rolė> --user-id <esamas-uuid>
# 3. Pakeisti AUTH_USERS įrašą, perkrauti serverį
```

⚠️ **Be `--user-id` skriptas sukuria naują tapatybę.** Rotacijos metu tai atsietų
vartotojo job'us ir audito įrašus nuo jo paskyros. Skriptas apie tai įspėja, bet
įpratimas paleisti jį be argumentų yra pagrindinė šio srauto klaida.

`memory` režime restartas išvalo sesijas, tad senas slaptažodis nebeveikia iš
karto. `postgres` režime sesijos restartą **išgyvena**, o slaptažodžio maiša
sesijoje nesaugoma – tad slaptažodžio pakeitimas pats savaime esamų seansų
NENUTRAUKIA.

⚠️ **`userId` KEISTI NEGALIMA – NET IR SEANSAMS ATJUNGTI.**
`docs/decisions/0001-stable-user-identity.md` tai draudžia tiesiogiai: pakeistas
ketvirtas laukas yra NAUJA tapatybė, tad vartotojo job'ai ir audito įrašai
atsietų nuo jo paskyros, o eilėje laukiantys darbai kristų kaip `ACTOR_UNKNOWN`.
Rotacija privalo naudoti `hash-password.js --user-id <esamas-uuid>` (žr. aukščiau).

**Kaip atjungti esamus seansus IŠSAUGANT stabilų ID:** laikinai pašalinti
vartotojo įrašą iš `AUTH_USERS`, perkrauti (startinis suderinimas revokuoja jo
sesijas), tada grąžinti įrašą su **tuo pačiu `userId`** ir perkrauti dar kartą.
Tapatybė nesikeičia, tad job'ai ir auditas lieka pririšti prie jos.

⚠️ Tai vienintelis šiandien palaikomas operatoriaus kelias. `destroyAllForUserId()`
saugykloje egzistuoja ir yra teisingas revokacijos primityvas, bet
administracinio endpoint'o jam dar nėra – žr. „Ko šis modelis NEAPIMA".

**`API_KEY` rotacija:** pakeisti reikšmę ir perkrauti. Senas raktas nustoja
veikti nedelsiant; sesijos nenukenčia.

⚠️ Rotacija reikalauja **restarto**, nes `AUTH_USERS` skaitomas iš aplinkos.
Nulinio prastovos rotacijai reikėtų vartotojų saugyklos duomenų bazėje.

---

## 6. Du autentifikacijos mechanizmai

Sistema priima **ir** sesijos cookie, **ir** bendrą `API_KEY`.

**Sesija turi pirmenybę.** Jei užklausa neša abu, autoritetinga yra konkreti
vartotojo tapatybė – priešingu atveju operatorius galėtų pasikelti teises vien
pridėdamas raktą.

```bash
API_KEY_ROLE=administrator   # numatyta
```

⚠️ **Kol `API_KEY_ROLE=administrator`, RBAC neriboja rakto turėtojų.** Tai
sąmoningas atgalinio suderinamumo sprendimas: iki #18 raktas galėjo viską, ir
numatytoji `operator` tyliai sulaužytų veikiančią automatiką. Startup apie tai
įspėja.

**Realiam rolių atskyrimui** rinkitės vieną:

- `API_KEY_ROLE=operator` – automatika netenka `job:delete` ir `export:original`
- Visiškai pereiti prie sesijų ir `API_KEY` nenaudoti

---

## 7. Dev režimas be autentifikacijos

Kai **nėra nei** `API_KEY`, **nei** `AUTH_USERS`, ir `NODE_ENV != production`,
užklausos praleidžiamos su `administrator` role, o konsolėje rodomas
įspėjimas.

Produkcijoje tas pats kelias grąžina **503**, ne praleidžia.

⚠️ Tai patogumas lokaliam kūrimui, ne diegimo režimas. Viešame diegime
**visada** nustatykite bent vieną mechanizmą.

---

## 8. Diegimo patikros sąrašas

Prieš viešą diegimą:

- [ ] `AUTH_USERS` nustatytas su bent vienu administratoriumi
- [ ] Slaptažodžiai sugeneruoti `hash-password.js`, ne rankomis
- [ ] `API_KEY_ROLE` apsvarstytas (numatyta `administrator` = RBAC neriboja rakto)
- [ ] `NODE_ENV=production`
- [ ] HTTPS (be jo `Secure` cookie nekeliaus)
- [ ] `CORS_ORIGIN` nurodytas konkrečiai, ne `*`
- [ ] Sesijų trukmės atitinka jūsų politiką
- [ ] `AUDIT_API_KEY` nustatytas arba prieiga per administratoriaus sesiją
- [ ] `SESSION_STORE_BACKEND` pasirinktas sąmoningai (`postgres` reikalauja
      `DATABASE_URL` ir paleistų migracijų)
- [ ] Perjungiant į `postgres`: naudotojai įspėti, kad reikės prisijungti iš
      naujo (esamos sesijos neperkeliamos)

---

## Ko šis modelis NEAPIMA

Sąžiningumo dėlei – ribos, kurios lieka atviros:

- **Nuosavybės patikrų nėra.** Rolė sprendžia, kokius veiksmus galima atlikti,
  bet ne su kieno duomenimis: bet kuris administratorius gali ištrinti bet kurį
  darbą.
- **Registracijos ir vartotojų valdymo UI nėra** – tik `AUTH_USERS` ir
  restartas.
- **Slaptažodžio keitimo srauto nėra** – tik per konfigūraciją.
- **Kelių replikų sesijos** veikia tik su `SESSION_STORE_BACKEND=postgres`;
  numatytoji atminties saugykla lieka viename procese.
- **Vartotojų saugyklos DB nėra** – `AUTH_USERS` tebėra konfigūracijoje, tad
  vartotojų sąrašo keitimas reikalauja aplinkos pakeitimo **ir restarto**.
  Konfigūracijos perkrovimo mechanizmo nėra; `touch()` tikrina rolę prieš gyvą
  `AUTH_USERS` tik tam, kad procese, kuris naują konfigūraciją jau turi, negalėtų
  išlikti sesija su pasenusia role.
- **Administracinio sesijų revokacijos endpoint'o nėra.** `destroyAllForUserId()`
  yra saugykloje, bet jo neiškviečia nė vienas maršrutas; seansams atjungti
  operatorius naudoja `AUTH_USERS` + restartą (žr. 5 skyrių).
- **PostgreSQL sesijos Docker Compose profiliuose neaktyvuojamos.**
  `SESSION_STORE_BACKEND=postgres` reikalauja `DATABASE_URL`, o oficialūs
  GPU/server profiliai sąmoningai naudoja `PG*` kintamuosius ir nurodo
  `DATABASE_URL` palikti tuščią (`.env.example`), be to `postgres` nėra
  backend'o `depends_on` ir profiliai neturi restart politikos. Persistentinės
  sesijos šiandien diegiamos tik ten, kur `DATABASE_URL` nustatomas
  eksplicitiškai. Tas pats apribojimas nuo 7.2a galioja ir
  `JOB_STORE_BACKEND=postgres`, tad tai ne 7.3 įvesta regresija.

  ⚠️ **Sprendimas NEKEISTI to 7.3 metu yra sąmoningas, ne praleidimas.** #181
  Docker profilių nemini nė karto (§7.1 ir §7.4 juos mini eksplicitiškai, tad
  tyla §7.3 yra pasirinkimas), o `PG*` priėmimas pažeistų jo kriterijų
  „pasirinkus `postgres`, `DATABASE_URL` privalomas". Prieš įjungiant
  persistentines sesijas Docker'yje reikia atskiro sprendimo: arba profiliai
  gauna `DATABASE_URL` ir `depends_on: postgres` su `condition: service_healthy`,
  arba backend'o parinkimas išmoksta `PG*` – pastarasis reikalautų pakeisti
  #181 priėmimo kriterijų.
- **MFA nėra.**
