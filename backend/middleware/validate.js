const { z } = require("zod");

/**
 * VALIDACIJA (#14).
 *
 * Iki šiol kiekvienas maršrutas tikrino įvestį savaip: `String(req.body?.x || "")`,
 * `typeof === "string"`, rankinės `if` grandinės. Kiekviena atskirai veikė, bet
 * kartu jos duoda tris skirtingus klaidų formatus ir tris skirtingas nuomones,
 * ką daryti su nežinomu lauku.
 *
 * Zod pasirinktas vietoj savo validatoriaus (priešingai nei logeriui): validacija
 * yra plati sritis su tipų išvedimu, kompozicija ir kraštiniais atvejais, o savas
 * sprendimas ilgainiui virstų puse bibliotekos - tik be testų ir dokumentacijos.
 */

/**
 * NEŽINOMI LAUKAI ATMETAMI (`strict`).
 *
 * Alternatyva - juos tyliai ignoruoti. Bet tada `{ varinat: "original" }`
 * (rašybos klaida) atrodytų kaip užklausa be varianto, ir klientas gautų
 * pranešimą apie trūkstamą lauką, kurį ką tik nurodė. Griežtas režimas paverčia
 * tai tiksliu pranešimu.
 *
 * Kaina: naujas kliento laukas lūžta iškart, o ne tyliai nieko nedaro. Tai
 * sąmoningas pasirinkimas - API sutartis turi būti aiški abiem pusėms.
 */

/** UUID arba mūsų generuojami ID formatai. Ilgis ribotas - jie patenka į logus. */
const identifier = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/, "leidžiami tik raidės, skaitmenys ir _ . : -");

/** Boolean, ateinantis kaip JSON true/false arba eilutė "true"/"false". */
const flexibleBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

/** Tik http/https - schemų sąrašas baltas, ne juodas. */
const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "laukiamas http arba https URL");

const schemas = {
  identifier,
  flexibleBoolean,

  jobIdParam: z.object({ id: identifier }),

  exportBody: z
    .object({
      variant: z.enum(["original", "redacted"]),
      format: z.enum(["txt", "csv", "docx"]),
      protocol: z.object({}).passthrough(),
      /**
       * `null` LEIDŽIAMAS, ne tik praleistas laukas.
       *
       * Įklijuoto teksto sraute transkribavimo jobo apskritai nėra, ir klientas
       * siunčia `jobId: null` - tai teisinga būsena, ne klaida. Reikalauti lauko
       * praleidimo reikštų, kad klientas turi žinoti mūsų vidinę taisyklę, o
       * `undefined` vs `null` skirtumas JSON'e dar ir nestabilus.
       */
      jobId: identifier.nullish(),
    })
    .strict(),

  /**
   * MULTIPART laukai ateina kaip EILUTĖS.
   *
   * `diarize=true` ir `numSpeakers=3` per `multipart/form-data` yra tekstas, ne
   * boolean ir ne skaičius. Todėl schema priima abu pavidalus ir konvertuoja -
   * kitaip klientas turėtų žinoti, kad JSON ir formos elgiasi skirtingai.
   */
  transcribeBody: z
    .object({
      language: z
        .string()
        .trim()
        .regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/, "laukiamas kalbos kodas, pvz. lt arba lt-LT")
        .nullish(),
      diarize: flexibleBoolean.nullish(),
      /**
       * `z.string().url()` NEPAKANKA: ji praleidžia `javascript:`, `file:` ir
       * `data:` schemas. Šis URL keliauja į transkribavimo tiekėją, tad
       * schemų sąrašas turi būti baltas, ne juodas.
       */
      audioUrl: httpUrl.nullish(),
      numSpeakers: z.coerce.number().int().min(1).max(50).nullish(),
      provider: identifier.nullish(),
      diarizationProvider: identifier.nullish(),
      meetingId: identifier.nullish(),
      jobId: identifier.nullish(),
    })
    .strict(),

  protocolJobBody: z
    .object({
      /**
       * `title`, `date`, `participants` ir `segments` NĖRA perteklius - juos
       * naudoja `generateProtocol()`, ir frontend juos siunčia.
       *
       * Pirmoji šios schemos versija jų neįtraukė, ir griežtas režimas būtų
       * atmetęs teisėtas užklausas: schema, aprašyta „iš atminties" o ne iš
       * realaus serviso parašo, tampa gedimu, ne apsauga.
       */
      title: z.string().trim().max(500).nullish(),
      date: z.string().trim().max(100).nullish(),
      participants: z.union([z.string().max(2000), z.array(z.string().max(200)).max(200)]).nullish(),
      segments: z.array(z.object({}).passthrough()).max(100_000).nullish(),
      // Ta pati riba kaip `generateBody.transcript` - jie apdorojami to paties
      // serviso, tad skirtingos ribos reikštų, kad kelias lemia turinį.
      transcript: z.string().trim().min(10, "transkripcija per trumpa").max(2_000_000),
      meetingId: identifier.nullish(),
      llmProviderOverride: identifier.nullish(),
      promptVersion: identifier.nullish(),
    })
    .strict(),

  generateBody: z
    .object({
      transcript: z.string().trim().min(10, "transkripcija per trumpa").max(2_000_000),
      title: z.string().trim().max(500).nullish(),
      date: z.string().trim().max(100).nullish(),
      participants: z.union([z.string().max(2000), z.array(z.string().max(200)).max(200)]).nullish(),
      segments: z.array(z.object({}).passthrough()).max(100_000).nullish(),
      meetingId: identifier.nullish(),
      jobId: identifier.nullish(),
      llmProviderOverride: identifier.nullish(),
      promptVersion: identifier.nullish(),
    })
    .strict(),
};

/**
 * KLIENTUI SIUNČIAMI PRANEŠIMAI KURIAMI MŪSŲ, NE BIBLIOTEKOS.
 *
 * Zod pranešimai atrodo nekalti, bet `unrecognized_keys` atveju jie ĮTRAUKIA
 * kliento pateiktą lauko pavadinimą:
 *
 *   { "Jonas_Jonaitis_39001010000": "x" }
 *   → "Unrecognized key: \"Jonas_Jonaitis_39001010000\""
 *
 * Tai reiškia, kad vartotojo kontroliuojamas tekstas - įskaitant PII - grįžtų
 * HTTP atsakyme, patektų į frontend klaidos pranešimą ir galiausiai į logus.
 * Tas pats mechanizmas, kurio vengiam visur kitur, čia atsirastų per biblioteką.
 *
 * Todėl pranešimai formuojami pagal `issue.code`, o ne perduodami pažodžiui.
 */
const ISSUE_MESSAGES = {
  unrecognized_keys: "Užklausoje yra neleidžiamų laukų.",
  invalid_type: "Lauko tipas netinkamas.",
  invalid_value: "Lauko reikšmė neleidžiama.",
  invalid_format: "Lauko formatas netinkamas.",
  too_big: "Lauko reikšmė per didelė.",
  too_small: "Lauko reikšmė per trumpa arba nepateikta.",
  invalid_union: "Lauko reikšmė netinka nė vienam leidžiamam variantui.",
};

function safeIssueMessage(issue) {
  return ISSUE_MESSAGES[issue.code] || "Lauko reikšmė netinkama.";
}

/**
 * Kelias irgi gali būti vartotojo kontroliuojamas.
 *
 * Įdėtame objekte raktai ateina iš kliento, tad `path` gali nešti tą patį
 * turinį kaip ir pranešimas. Praleidžiam tik tai, kas panašu į lauko vardą;
 * visa kita pakeičiam žymeniu, kad klientas vis tiek matytų struktūrą.
 */
function safePath(path) {
  return path
    .slice(0, 8)
    .map((part) => {
      if (typeof part === "number") return String(part);
      return /^[A-Za-z0-9_-]{1,64}$/.test(part) ? part : "[laukas]";
    })
    .join(".");
}

/**
 * VIENAS klaidų formatas visoms validacijoms.
 *
 * `path` leidžia klientui parodyti, kuris laukas blogas, o `code` - reaguoti
 * programiškai. Nei stack trace, nei vidinių detalių, nei kliento teksto.
 */
function formatIssues(error) {
  return {
    error: "Netinkami užklausos duomenys.",
    code: "VALIDATION_FAILED",
    // Skaičius ribotas, kad pigi užklausa negalėtų sugeneruoti didelio atsakymo.
    details: error.issues.slice(0, 20).map((issue) => ({
      path: safePath(issue.path),
      code: issue.code,
      message: safeIssueMessage(issue),
    })),
  };
}

/**
 * @param {{body?: import("zod").ZodTypeAny, query?: import("zod").ZodTypeAny, params?: import("zod").ZodTypeAny}} spec
 */
function validate(spec) {
  return (req, res, next) => {
    for (const source of ["params", "query", "body"]) {
      const schema = spec[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (!result.success) return res.status(400).json(formatIssues(result.error));

      /**
       * Rezultatas dedamas į `req.validated`, o ne į `req.body`.
       *
       * Express 5 `req.query` yra tik skaitomas, o perrašinėti `req.body`
       * reikštų, kad kitas skaitytojas nebežino, ar mato žalią, ar patikrintą
       * reikšmę. Atskiras laukas tą dviprasmybę pašalina.
       */
      req.validated = { ...(req.validated || {}), [source]: result.data };
    }

    next();
  };
}

module.exports = { validate, schemas, formatIssues, safePath, safeIssueMessage, z };
