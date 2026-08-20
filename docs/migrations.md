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
