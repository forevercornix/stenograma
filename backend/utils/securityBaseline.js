const cors = require("cors");
const helmet = require("helmet");
const { createLogger } = require("./logger");
const { resolveTrustProxy } = require("./clientIp");

const log = createLogger("security");

/**
 * CENTRINIS SAUGUMO SLUOKSNIS (#14).
 *
 * Iki šiol saugumo nustatymai buvo išbarstyti po `server.js`: CORS vienoje
 * vietoje, body limitas kitoje, rate limitai maršrutuose. Kiekvienas atskirai
 * teisingas, bet niekas negalėjo atsakyti į klausimą „kokia yra šio API saugumo
 * bazė" nepersakant viso failo.
 *
 * Modulis registruojamas PRIEŠ maršrutus, tad naujas endpointas bazę gauna
 * automatiškai - o ne tada, kai kas nors prisimena pridėti.
 */

/** Numatytas JSON kūno limitas. Audio eina per multipart, tad JSON gali būti mažas. */
const DEFAULT_JSON_LIMIT = "1mb";

/**
 * CORS kilmių sąrašas.
 *
 * `*` leidžiamas tik SĄMONINGAI ir niekada kartu su credentials: naršyklė tokio
 * derinio ir taip neleistų, bet tyli konfigūracija reikštų, kad administratorius
 * mano turintis apsaugą, kurios nėra.
 */
/**
 * Kilmė turi būti `scheme://host[:port]` - be kelio, užklausos ir prisijungimo
 * duomenų. Naršyklė netinkamos kilmės ir taip nesutapatintų, bet tada CORS
 * tyliai neveiktų be aiškios priežasties, o administratorius manytų, kad
 * sąrašas galioja.
 */
function assertValidOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw _configError(`CORS_ORIGIN įrašas "${value}" nėra galiojanti kilmė (laukiama scheme://host[:port]).`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw _configError(`CORS_ORIGIN įrašas "${value}": leidžiami tik http ir https.`);
  }
  if (url.username || url.password) {
    throw _configError(`CORS_ORIGIN įrašas "${value}" negali turėti prisijungimo duomenų.`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw _configError(`CORS_ORIGIN įrašas "${value}": kilmė yra tik scheme://host[:port], be kelio.`);
  }

  return url.origin;
}

function _configError(message) {
  const error = new Error(message);
  error.code = "CORS_ORIGIN_INVALID";
  return error;
}

/**
 * Skaitinė nuostata su ribomis.
 *
 * `parseInt("abc")` duoda `NaN`, o `NaN` timeout'as reiškia momentinį
 * nutrūkimą; `RATE_LIMIT_GENERAL_MAX=0` užblokuotų visą API. Abiem atvejais
 * tylus numatytasis būtų blogesnis nei klaida: administratorius matytų
 * nustatytą reikšmę, o sistema elgtųsi kitaip.
 */
function requirePositiveInt(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    const error = new Error(`${name}="${raw}" netinkama - laukiamas sveikas skaičius nuo ${min} iki ${max}.`);
    error.code = "SECURITY_CONFIG_INVALID";
    throw error;
  }

  return value;
}

/** Express kūno limitas: `1mb`, `500kb` arba baitų skaičius. */
const BODY_LIMIT_SHAPE = /^\d+(\.\d+)?(b|kb|mb|gb)?$/i;

function requireBodyLimit(env, fallback) {
  const raw = (env.JSON_BODY_LIMIT || "").trim();
  if (!raw) return fallback;

  if (!BODY_LIMIT_SHAPE.test(raw)) {
    const error = new Error(`JSON_BODY_LIMIT="${raw}" netinkamas - laukiama pvz. "1mb", "500kb" arba baitų skaičiaus.`);
    error.code = "SECURITY_CONFIG_INVALID";
    throw error;
  }

  return raw;
}

function resolveCorsOptions(env = process.env) {
  const raw = (env.CORS_ORIGIN || "http://localhost:5173").trim();
  const credentials = String(env.CORS_CREDENTIALS || "").toLowerCase() === "true";

  if (raw === "*") {
    if (credentials) {
      const error = new Error(
        "CORS_ORIGIN=* negali būti derinamas su CORS_CREDENTIALS=true - naršyklė tokio derinio " +
          "neleidžia, o konfigūracija sudarytų apsaugos įspūdį. Nurodykite konkrečias kilmes."
      );
      error.code = "CORS_UNSAFE_COMBINATION";
      throw error;
    }

    /**
     * Literalas `*`, o NE `true`.
     *
     * `origin: true` atspindi užklausos `Origin` antraštę - rezultatas su
     * `credentials: false` toks pat, bet atspindėjimas yra šablonas, kuris tampa
     * pavojingas vos kam nors įjungus credentials. Literalas tokios galimybės
     * neturi ir aiškiai pasako, kas vyksta.
     */
    return { origin: "*", credentials: false, exposedHeaders: EXPOSED_HEADERS };
  }

  // Allow-list: kableliais atskirtos kilmės, kiekviena patikrinta atskirai.
  const entries = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw _configError("CORS_ORIGIN nustatytas, bet tuščias - nurodykite bent vieną kilmę arba palikite nenustatytą.");
  }
  if (entries.includes("*")) {
    throw _configError("CORS_ORIGIN negali maišyti `*` su konkrečiomis kilmėmis - pasirinkite vieną.");
  }

  return { origin: entries.map(assertValidOrigin), credentials, exposedHeaders: EXPOSED_HEADERS };
}

/**
 * Antraštės, kurias klientas turi galėti PERSKAITYTI cross-origin.
 *
 * Be jų naršyklė jas paslepia: eksporto failo vardas nusileisdavo į bendrinį, o
 * `X-Request-Id` klientui buvo nematomas, nors visa koreliacijos prasmė yra jį
 * grąžinti.
 */
const EXPOSED_HEADERS = ["Content-Disposition", "X-Request-Id"];

/**
 * Registruoja saugumo bazę. Kviečiama PRIEŠ visus maršrutus.
 *
 * @param {import("express").Express} app
 */
function applySecurityBaseline(app, env = process.env) {
  /**
   * `trust proxy` nustatomas eksplicitiškai: be jo už nginx visi klientai atrodo
   * kaip 127.0.0.1 (bendras rate limitas), o aklas `true` leistų klastoti
   * `X-Forwarded-For` ir limitą apeiti.
   */
  app.set("trust proxy", resolveTrustProxy(env));

  /**
   * Saugumo antraštės. `contentSecurityPolicy` išjungtas sąmoningai: šis procesas
   * atiduoda tik JSON ir failus, o CSP taikoma HTML atsakymams - frontend'ą
   * aptarnauja nginx, kuris turi savo konfigūraciją.
   */
  app.use(
    helmet({
      /**
       * CSP NEIŠJUNGIAMA - ji nustatoma griežčiausia įmanoma.
       *
       * Pirma versija ją išjungė argumentu „šis procesas atiduoda tik JSON".
       * Argumentas teisingas, bet išvada klaidinga: būtent todėl, kad HTML čia
       * niekada nesiunčiamas, `default-src 'none'` nieko nelaužo ir apsaugo
       * klaidos puslapius bei bet kokį būsimą HTML atsakymą.
       *
       * Išjungta CSP taip pat yra CodeQL radinys - ir pagrįstai: „mums jos
       * nereikia" galioja tik tol, kol niekas neprideda HTML maršruto.
       */
      contentSecurityPolicy: {
        directives: {
          "default-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'none'"],
        },
      },
      // Eksportuojami failai atsisiunčiami kryžmine kilme, tad griežčiausia
      // reikšmė čia sulaužytų funkcionalumą be saugumo naudos.
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  app.use(cors(resolveCorsOptions(env)));

  const jsonLimit = requireBodyLimit(env, DEFAULT_JSON_LIMIT);
  const express = require("express");

  app.use(express.json({ limit: jsonLimit }));
  // Formos duomenų šis API nenaudoja, bet limitas vis tiek nustatomas - kitaip
  // numatytasis liktų neribotas naujam endpointui, kuris juos kada nors priims.
  app.use(express.urlencoded({ extended: false, limit: jsonLimit }));

  log.info("Saugumo bazė registruota", {
    trustProxy: String(resolveTrustProxy(env)),
    jsonLimit,
    corsMode: (env.CORS_ORIGIN || "").trim() === "*" ? "wildcard" : "allow-list",
  });
}

module.exports = {
  applySecurityBaseline,
  resolveCorsOptions,
  requirePositiveInt,
  requireBodyLimit,
  EXPOSED_HEADERS,
  DEFAULT_JSON_LIMIT,
};
