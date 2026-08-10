# Prisidėjimas prie Stenograma

Ačiū už susidomėjimą. Prieš siunčiant pull request'ą, vieną dalyką būtina
perskaityti — jis netipinis ir svarbus.

## Įnašų licencijavimo sąlygos (svarbu)

Stenograma platinama pagal **dvigubą licenciją**: atvirojo kodo
**EUPL-1.2-or-later** (SPDX license identifier: `EUPL-1.2`) ir atskira
komercinė licencija (žr. [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md)).

Kad projekto prižiūrėtoja galėtų toliau išduoti komercines licencijas, ji turi
turėti pakankamas relicencijavimo teises į **visą** projekto kodą. Todėl, siųsdami pull
request'ą ir patvirtindami tai PR šablono varnele, jūs:

1. patvirtinate, kad kodas yra jūsų sukurtas ir turite teisę jį perduoti;
2. suteikiate projekto prižiūrėtojai neišimtinę, neterminuotą, neatšaukiamą,
   pasaulinę teisę jūsų įnašą naudoti, modifikuoti ir platinti **bet kokia
   licencija**, įskaitant komercinę;
3. patvirtinate, kad jūsų įnašas nepažeidžia trečiųjų šalių teisių.

Jūs išsaugote savo autorystę ir teises į savo kodą — tai nėra teisių atsisakymas,
o leidimas juos naudoti dvigubos licencijos modelyje.

Jei tai jums nepriimtina, prašom nesiųsti PR — bet pranešimai apie klaidas
(issues) visada laukiami ir jokio teisių klausimo nekelia.

**Formalumo lygis.** Šios sąlygos kartu su PR šablono patvirtinimu yra
lengvasvoris įnašų licencijavimo susitarimas, o ne pasirašytas Contributor
License Agreement. Stambesniems įnašams arba prieš komercinį sandorį
prižiūrėtoja gali paprašyti atskiro rašytinio susitarimo.

**Jei naudojote AI įrankius** kodui generuoti, nurodykite tai PR aprašyme.
Tai ne kliūtis — tai skaidrumo reikalavimas, kurio šiame projekte laikomasi
nuosekliai.

## Techniniai reikalavimai

Prieš siunčiant:

```bash
cd backend && npm test && npm run lint
cd ../frontend && npx vitest run && npm run build
```

Šiame projekte galioja taisyklė: **jei pakeitimas liečia dokumentacijoje
nurodytą faktą (skaičių, kintamojo vardą, komandą), dokumentacija keičiama
tame pačiame PR.** Dalis testų tai tikrina automatiškai.

## Klaidų pranešimai

Saugumo spragų **neteikite** per viešus issue — žr. [`SECURITY.md`](SECURITY.md).
