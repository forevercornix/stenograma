/**
 * RESURSŲ KRŪVA ADAPTERIŲ PARUOŠIMUI (#180 P2-A).
 *
 * ⚠️ PROBLEMA: `setup()` KRENTA PO DALIES RESURSŲ SUKŪRIMO.
 *
 * Kontrakto vykdytojas turi formą
 *
 *     const ctx = await adapter.setup();
 *     try { ... } finally { await ctx.cleanup(); }
 *
 * Jei `setup()` meta PRIEŠ grąžindamas `ctx`, išorinis `finally` NIEKADA
 * neįvykdomas, o `setup()` jau galėjo sukurti admin `Pool`'ą, laikiną duomenų
 * bazę ir darbinį `Pool`'ą. Jie nutekėtų: `pg` pool laiko event loop'ą gyvą,
 * tad `node --test` procesas nebesibaigtų, o laikina DB liktų serveryje.
 *
 * ⚠️ NUOSAVYBĖ TEN, KUR RESURSAS SUKURIAMAS. Kvietėjas negali sutvarkyti to,
 * ko niekada negavo, todėl atsakomybė lieka `setup()` viduje: kiekvienas
 * resursas registruojamas IŠ KARTO po sukūrimo, ir klaidos atveju krūva
 * išvyniojama atvirkštine tvarka.
 *
 * ⚠️ VALYMAS NEUŽDENGIA PIRMINĖS KLAIDOS. Pirminė `setup()` klaida visada
 * metama toliau; valymo nesėkmės kaupiamos `klaida.valymoKlaidos` masyve, kad
 * liktų matomos, bet nepakeistų diagnozės.
 */

/**
 * Apvalkalas, garantuojantis, kad veiksmas įvyks NE DAUGIAU nei kartą.
 *
 * Būtinas todėl, kad sėkmės kelias kai kuriuos resursus uždaro iš karto
 * (pvz. admin `Pool` po DB sukūrimo), o krūva juos vis tiek turi - `pg`
 * `pool.end()` iškviestas antrą kartą grąžina atmestą Promise.
 */
function vienaKarta(veiksmas) {
  let atlikta = false;
  return async () => {
    if (atlikta) return false;
    atlikta = true;
    await veiksmas();
    return true;
  };
}

function sukurtiResursuKruva() {
  const irasai = [];

  return {
    /** Registruoja jau SUKURTĄ resursą. Kviesti iš karto po sukūrimo. */
    registruoti(kas, veiksmas) {
      irasai.push({ kas, veiksmas: vienaKarta(veiksmas) });
    },

    /** Kiek resursų šiuo metu laikoma (diagnostikai ir testams). */
    kiek() {
      return irasai.length;
    },

    /**
     * Išvynioja krūvą ATVIRKŠTINE tvarka. Naudojama ir klaidos, ir sėkmės
     * (`cleanup()`) keliuose, tad valymo logika yra VIENA.
     *
     * @param {Error} [klaida] - pirminė klaida, jei valoma po nesėkmės.
     */
    async isvalyti(klaida) {
      const eile = irasai.splice(0, irasai.length).reverse();
      const nesekmes = [];
      for (const { kas, veiksmas } of eile) {
        try {
          await veiksmas();
        } catch (e) {
          nesekmes.push(`${kas}: ${e.message}`);
        }
      }
      if (nesekmes.length === 0) return;
      if (klaida) {
        klaida.valymoKlaidos = (klaida.valymoKlaidos || []).concat(nesekmes);
        return;
      }
      throw new Error(`resursų valymas nepavyko: ${nesekmes.join("; ")}`);
    },
  };
}

module.exports = { sukurtiResursuKruva, vienaKarta };
