/**
 * FAZIŲ FIXTURE'AI TESTAMS (#154).
 *
 * Po #154 `status` yra state machine valdomas laukas: `jobStore.update()` jo
 * nebepriima, o `finish()` draudžia `queued → completed` (nevykdytas darbas
 * negali būti baigtas sėkmingai).
 *
 * Testams dažnai reikia tiesiog „job'o, kuris atrodo baigtas". Anksčiau tai
 * buvo vienas `update({ status: "completed" })`. Dabar realus kelias yra
 * `restart()` → `finish()`, ir šie helperiai jį atkartoja – tad fixture'as
 * eina TĄ PATĮ kelią kaip produkcija, o ne apeina invariantą.
 */

/** Job'as pereina į `processing` (fazė `validating`). */
async function markProcessing(store, id, extra = {}) {
  return store.restart(id, extra);
}

/**
 * Job'as realiai pravedamas iki `completed`.
 *
 * ⚠️ REZULTATAS PRIDEDAMAS PAGAL NUTYLĖJIMĄ (#184, Codex E2).
 *
 * Nuo 7.5b `completed` BE rezultato yra atskira, REMONTUOTINA būsena: audio
 * barjeras tokiam įrašui šalinimo neleidžia, nes šaltinis yra vienintelė
 * medžiaga remontui. Fixture, gaminantis tokią būseną „patogumo dėlei",
 * gamintų sugadintą job'ą ir verstų testus matuoti ne tai, ką tikrina.
 *
 * Kvietėjas, kuriam REIKIA būtent remontuotinos būsenos, perduoda
 * `{ result: null }` eksplicitiškai — tada tai matoma teste, o ne paslėpta
 * helperyje.
 */
async function markCompleted(store, id, extra = {}) {
  await store.restart(id);
  const su = "result" in extra ? extra : { ...extra, result: { text: "fixture" } };
  return store.finish(id, "completed", su);
}

/** Job'as pravedamas iki `failed`. */
async function markFailed(store, id, extra = {}) {
  await store.restart(id);
  return store.finish(id, "failed", extra);
}

module.exports = { markProcessing, markCompleted, markFailed };
