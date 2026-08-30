/**
 * IŠTRYNIMO ATSAKYMŲ ATVAIZDAVIMAS Į HTTP (#155, 7.5a / #183).
 *
 * ⚠️ VIENA VIETA DVIEM MARŠRUTAMS - SĄMONINGAI.
 *
 * `/api/jobs` ir `/api/transcribe-jobs` turėjo identiškas atsakymo kopijas.
 * 7.5a įveda du naujus barjero nulemtus atsakymus (202 ir `tombstone_unresolved`),
 * ir dvi kopijos beveik neišvengiamai išsiskirtų: vienas endpoint'as grąžintų
 * 202, kitas toliau 204 tam pačiam scenarijui (AGENTS.md §16).
 *
 * ⚠️ KLAIDŲ TEKSTAI KLIENTUI NESIUNČIAMI.
 *
 * `outcome.errors` elementai yra `storage: <žinutė>`, `jobStore: <žinutė>` -
 * juose būna failų kelių, saugyklos ir Redis raktų. #19 tai draudžia
 * („expose no filesystem paths, storage keys, Redis keys, provider payloads or
 * deleted content"). Savininko kelias šios taisyklės laikėsi, našlaičių kelias
 * siųsdavo visą `outcome` - įskaitant `errors`. Klientas gauna TIK tai, KAS
 * pašalinta; pilnas tekstas lieka serverio loguose.
 */

const DELETION_STATUS = {
  IN_PROGRESS: "in_progress",
  TOMBSTONE_UNRESOLVED: "tombstone_unresolved",
};

/** Kiek pašalinta - be jokių žinučių. */
function saugusOutcome(outcome) {
  if (!outcome) return null;

  return {
    jobRemoved: outcome.jobRemoved,
    queueJobRemoved: outcome.queueJobRemoved,
    storageRemoved: outcome.storageRemoved,
    auditEntriesRemoved: outcome.auditEntriesRemoved,
  };
}

/**
 * ⚠️ 202 NĖRA SĖKMĖ IR NĖRA GEDIMAS.
 *
 * Jis reiškia: autoritetingas vykdytojas yra KITAS procesas, o šis kvietimas
 * sąmoningai NEPRADĖJO jokio destruktyvaus darbo. Klientas gali kartoti vėliau
 * ir gaus 204, kai ištrynimas bus patvirtintas.
 */
function barjeroAtsakymas(res, statusas) {
  if (statusas === DELETION_STATUS.IN_PROGRESS) {
    return res.status(202).json({
      status: statusas,
      message: "Šio jobo ištrynimas jau vykdomas. Pakartokite užklausą vėliau.",
    });
  }

  /**
   * ⚠️ ATSAKYMAS NIEKO NETEIGIA APIE DUOMENIS - IR TAI ESMINIS DALYKAS.
   *
   * `tombstone_unresolved` kyla DVIEM skirtingais atvejais:
   *
   *   1. ištrynimas realiai nepavyko ar buvo dalinis - saugyklos, eilės ar
   *      audito pėdsakų GALI BŪTI LIKĘ;
   *   2. duomenys pašalinti, bet terminalus žymos perėjimas nepavyko.
   *
   * Transporto sluoksnis jų atskirti negali, tad ankstesnė žinutė („duomenys
   * pašalinti") pirmuoju atveju buvo MELAS - tiksliai ta klaidos rūšis, kurią
   * 7.5a ir taiso. Sakom tik tai, kas tikrai žinoma: operacija neužbaigta.
   */
  return res.status(503).json({
    error:
      "Ištrynimas neužbaigtas: žyma liko neišspręsta. Operaciją turi užbaigti " +
      "operatorius; duomenų būklė iš šio atsakymo nenustatoma.",
    status: statusas,
  });
}

/** Savininko ir administracinis kelias (`lifecycleService` rezultatas). */
function atsakytiIstrynimu(res, result, { jobId, log, kategorijos = true }) {
  if (
    result.status === DELETION_STATUS.IN_PROGRESS ||
    result.status === DELETION_STATUS.TOMBSTONE_UNRESOLVED
  ) {
    log.warn(`Ištrynimas neužbaigtas dėl barjero būsenos: ${jobId} → ${result.status}`);
    return barjeroAtsakymas(res, result.status);
  }

  if (!result.complete) {
    log.error(`NEPAVYKO visiškai ištrinti jobo ${jobId}: statusas=${result.status}`);

    return res.status(503).json({
      error:
        "Nepavyko visiškai ištrinti jobo duomenų. Jobas paliktas, kad užklausą būtų galima pakartoti.",
      deletion: kategorijos
        ? { status: result.status, categories: result.categories }
        : { status: result.status },
    });
  }

  return res.status(204).send();
}

/** Našlaičių valymas (`adminJobService` rezultatas). */
function atsakytiNaslaicioValymu(res, result, { jobId, log }) {
  if (result.barjeras === "already_deleted") return res.status(204).send();

  if (result.barjeras) {
    log.warn(`Našlaičio valymas neužbaigtas dėl barjero būsenos: ${jobId} → ${result.barjeras}`);
    return barjeroAtsakymas(res, result.barjeras);
  }

  if (!result.cleaned) {
    log.error(
      `NEPAVYKO ištrinti likusių jobo ${jobId} duomenų: ${result.outcome.errors.join("; ")}`
    );

    return res.status(503).json({
      error: "Nepavyko visiškai ištrinti jobo duomenų. Užklausą galima pakartoti.",
      deletion: saugusOutcome(result.outcome),
    });
  }

  if (result.outcome.found) return res.status(204).send();
  return res.status(404).json({ error: "Jobas nerastas." });
}

module.exports = { atsakytiIstrynimu, atsakytiNaslaicioValymu, saugusOutcome };
