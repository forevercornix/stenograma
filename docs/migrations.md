# Migracijos

`node-pg-migrate`, ne ORM — projektas jo neturi ir nereikalauja.

⚠️ **Prievadas gali būti užimtas.** Compose publikuoja PostgreSQL ties
`127.0.0.1:${POSTGRES_HOST_PORT:-5432}`. Jei mašinoje jau veikia kitas
PostgreSQL, nustatykite kitą reikšmę šakniniame `.env` ir atitinkamai pakeiskite
`DATABASE_URL`:

```bash
POSTGRES_HOST_PORT=55432
DATABASE_URL=postgres://stenograma:...@localhost:55432/stenograma
```

⚠️ **Komandos vykdomos `backend/` kataloge.** `migrate:*` skriptai gyvena
`backend/package.json`, o `.node-pg-migraterc` kelias (`dir: "migrations"`)
irgi santykinis jam. Šakninio `package.json` repo neturi.

```bash
cd backend
DATABASE_URL=postgres://... npm run migrate:up
DATABASE_URL=postgres://... npm run migrate:create pavadinimas
```

Arba iš šaknies:

```bash
DATABASE_URL=postgres://... npm --prefix backend run migrate:up
```

⚠️ **`checkOrder: true`** sąmoningai: jei kas nors prideda migraciją su
ankstesne laiko žyme nei jau pritaikyta, `node-pg-migrate` sustos, o ne
pritaikys ją ne eilės tvarka. Tyliai pritaikyta migracija ne eilės tvarka
reikštų, kad dvi aplinkos turi tą pačią `pgmigrations` lentelę, bet skirtingą
schemą.

Schemos turinys — 7.2a (#179). Šis PR pateikia tik karkasą.

---

## ⚠️ Atnaujinant į 7.4e: `PG*` diegimai ir `erasure_marks`

**Kas pasikeitė.** Iki 7.4e ištrynimo žymos rinkosi PostgreSQL **tik** pagal
`DATABASE_URL`. Diegimas, konfigūruotas per `PGHOST`/`PGUSER`/… (dokumentuotas
Compose kelias), tyliai laikė žymas atmintyje, nors auditas jau rašė į duomenų
bazę. Nuo 7.4e `PG*` priimamas lygiai taip pat.

**Ką tai reiškia operatoriui.** `PG*`-only diegime `erasure_marks` lentelė nuo
šiol **privaloma**:

- jei migracijos pritaikytos — nieko daryti nereikia;
- jei ne — `/api/ready` grąžins `503` su `auditBarrierReachable: false`, o
  blokuojantis auditas (pvz. prisijungimas) kris `AUDIT_WRITE_FAILED`.
  Procesas **nekrinta** ir liveness (`/api/health`) lieka `200`, tad langas
  migracijoms pritaikyti išlieka.

**Veiksmas.** Prieš atnaujinant paleiskite migracijas prieš **tą pačią** duomenų
bazę, į kurią rodo audito pool'as:

```bash
cd backend
DATABASE_URL=postgres://... npm run migrate:up
```

⚠️ Aukščiau esančios komandos naudoja `DATABASE_URL`. `PG*`-only diegime
nurodykite jį **laikinai, tik migracijoms** — arba įsitikinkite, kad
`node-pg-migrate` jungiasi prie tos pačios bazės. Migravus į kitą bazę nei
audito, barjeras liktų neveikiantis, o `/api/ready` — teisėtai `503`.

Garantijos formuluotė — `docs/deletion-guarantees.md` §1 ir §2.
