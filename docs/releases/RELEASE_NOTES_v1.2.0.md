# v1.2.0 — GDPR ir saugumo programa

Šis leidimas nepridėjo naujų vartotojo funkcijų. Jis padarė kitą dalyką: pavertė
esamas privatumo ir saugumo prielaidas **tikrinamomis garantijomis**.

Testų buvo 118, dabar **558** (plius 55 frontend ir 11 integracinių su tikru
Redis). Bet svarbesnis skaičius kitas: kiekviena garantija turi **mutacijos
įrodymą** — patikrinta, kad testas realiai krinta, kai saugoma savybė pašalinama.
Šioje programoje ne kartą pasitaikė testų, kurie praeidavo ir tada, kai
tikrinama savybė buvo pašalinta; be mutacijų jie būtų likę žali ir bereikšmiai.

---

## Kas nauja

**Automatinė PII redakcija** (#4) — LT asmens kodai su kontroline suma, el.
paštas, telefonai, IBAN. Redaguotas turinys keliauja kaip **artefaktas** su
variantu ir politikos versija, tad apsaugos tikrina faktą, ne prielaidą.

**Konfigūruojamas privatumo režimas** (#5) — užšaldyta politika, išorinių tiekėjų
kontrolė, eksporto apribojimai. Netinkama konfigūracija stabdo startą, o ne
pasirodo pirmoje užklausoje.

**Originalus ir redaguotas eksportas** (#8) — variantas privalomas ir niekada
neišvedamas. Politika gali variantą uždrausti, bet **niekada nepakeičia kitu**:
„paprašiau redaguoto, gavau originalą" atrodo lygiai taip pat kaip teisingas
atsakymas.

**API saugumo bazė** (#14) — vienas modulis prieš maršrutus: saugumo antraštės,
CORS allow-list, kūno limitai, rate limitai. Validacija per zod visuose
maršrutuose su vienu klaidų formatu.

**Observability ir koreliacija** (#17) — vienas `X-Request-Id` sujungia užklausą,
eilę, worker'į, tiekėjo kvietimą ir pabaigą. IP loguose tik kaip pseudonimas.

**CI ir tiekimo grandinė** (#16) — politika, kurią **vykdo** CI, o ne tik
dokumentas. PR blokuojantis priklausomybių auditas.

**Saugumo testų matrica** (#15) — kuris testas saugo kurią garantiją ir kokia
mutacija tai įrodo, su patikra, kad dokumentas nesentų.

---

## Kas buvo sulaužyta ir ištaisyta

Programa rado ir realių defektų, ne tik pridėjo apsaugų:

- **`dependabot.yml` buvo sintaksiškai neteisingas** — GitHub jį atmetė tyliai,
  tad nė viena priklausomybė niekada nebuvo tikrinama. Konfigūracijos failas
  egzistavo, tad atrodė, kad viskas veikia.
- **`frontend` turėjo `high` pažeidžiamumą**, rastą pirmą kartą paleidus auditą.
- **Eksporto apsauga buvo silpnesnė nei LLM kelio** — būtent ten, kur failas
  keliauja tiesiai vartotojui.
- **Repair retry perrašydavo redakcijos metaduomenis** — API rodydavo, kad
  neredaguota nieko, nors asmens kodas buvo pašalintas.
- **Failo vardas ir `X-Request-Id` nebuvo eksponuojami CORS** — cross-origin
  diegime jie tyliai dingdavo.
- **Worker'is žymėdavo galutinę nesėkmę tarpiniam bandymui**, po kurio jobas dar
  būdavo kartojamas.
- **Telefonų aptikimas laikė telefonais sutarčių numerius**, o asmens kodas po
  brūkšnelio praeidavo neredaguotas.

## Priklausomybių atnaujinimai

Node 20 → **22**, React 18 → **19** (kartu su `lucide-react` — atskirai nė vienas
neveikia), Tailwind 3 → **4** su klasių pervadinimais, kad išvaizda nepasikeistų.
`outline-none` → `outline-hidden` pakeliui ištaisė fokuso indikatorių
prieinamumą.

---

## Sąžiningai apie ribas

Rezultatas yra **dalinai pseudonimizuotas, ne anonimizuotas**. Vardai paliekami
sąmoningai — protokole jie yra dokumento turinys. Adresai neaptinkami, o žodžiais
padiktuoti identifikatoriai praeina.

Neapima taip pat: semantinio PII aptikimo, vizualinių regresijų, realaus GPU
kelio ir apkrovos testų. Pilnas sąrašas — `docs/security-test-matrix.md` skyriuje
**„Ko ši matrica neapima"**.

Projektas lieka **portfolio reference implementation**, ne production-ready
sistema.

---

## Atnaujinimas

```bash
git pull && git checkout v1.2.0
cd backend && npm ci
cd ../frontend && npm ci
```

Reikalingas **Node 22+** (buvo 20). Naujos aplinkos nuostatos aprašytos
`backend/.env.example`; visos turi saugius numatytuosius, tad esami diegimai
veikia be pakeitimų.

**Pilnas sąrašas:** [`CHANGELOG.md`](CHANGELOG.md)
