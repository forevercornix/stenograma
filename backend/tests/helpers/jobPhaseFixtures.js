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

/** Job'as realiai pravedamas iki `completed`. */
async function markCompleted(store, id, extra = {}) {
  await store.restart(id);
  return store.finish(id, "completed", extra);
}

/** Job'as pravedamas iki `failed`. */
async function markFailed(store, id, extra = {}) {
  await store.restart(id);
  return store.finish(id, "failed", extra);
}

module.exports = { markProcessing, markCompleted, markFailed };
