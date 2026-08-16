# Sprendimų žurnalas (ADR)

Čia fiksuojami architektūriniai sprendimai, kurie **riboja būsimą darbą** — ne kiekvienas
techninis pasirinkimas. Įrašas reikalingas, kai sprendimas atitinka bent vieną sąlygą:

- vėlesnis jo keitimas reikštų duomenų migraciją, ne refaktoringą;
- jis sąmoningai atmeta akivaizdesnę alternatyvą;
- jis keičia elgesį, kurį kas nors vėliau galėtų palaikyti regresija.

Formatas trumpas ir pastovus: kontekstas, sprendimas, alternatyvos, pasekmės. Įrašai
nekeičiami — pasikeitus sprendimui rašomas naujas, o senas pažymimas kaip pakeistas.

Ši konvencija **tęsia #117 naudotą decision-log principą** (Decision / Rationale /
Consequences / Limitations), tik iškelia jį iš konkretaus issue į repo lygį. Tai ne antra
lygiagreti sistema: issue viduje vedami sprendimai lieka ten, kur jie priimti, o čia
patenka tie, kurie riboja darbą už to issue ribų.

| Nr. | Sprendimas | Statusas |
|---|---|---|
| [0001](0001-stable-user-identity.md) | Stabilus vartotojo identitetas `AUTH_USERS` ketvirtame lauke | Priimtas |
