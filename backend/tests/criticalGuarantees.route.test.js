const test = require("node:test");
const assert = require("node:assert/strict");

const API_KEY = "testinis-raktas-kritinems-garantijoms";

process.env.NODE_ENV = "test";
process.env.API_KEY = API_KEY;
process.env.LLM_PROVIDER = "mock";
process.env.TRANSCRIPTION_PROVIDER = "mock";
process.env.DIARIZATION_PROVIDER = "none";
process.env.LOG_LEVEL = "error";
process.env.RATE_LIMIT_MAX_REQUESTS = "500";
process.env.RATE_LIMIT_GENERAL_MAX = "500";

const request = require("supertest");
const app = require("../server");
app._setReadyForTests();

/**
 * KRITINĖS GARANTIJOS - REGRESIJOS PER VISUS MARŠRUTUS (#15).
 *
 * Ankstesni testai tikrina garantijas TEN, KUR JOS BUVO ĮGYVENDINTOS: `#14`
 * testai tikrina `/api/exports` validaciją, `security.route` - `/api/generate`
 * autentifikaciją. Kiekvienas atskirai teisingas, bet kartu jie palieka tylią
 * spragą: naujas maršrutas arba maršrutas, iš kurio kas nors pašalino
 * `apiKeyAuth`, nebus pastebėtas, nes jo niekas atskirai netikrina.
 *
 * Šis failas tikrina garantijas KAIP RINKINĮ - per visus maršrutus vienodai.
 * Jei atsiranda naujas maršrutas, jį reikia įrašyti čia arba eksplicitiškai
 * pažymėti kaip viešą; abu sprendimai matomi peržiūroje.
 */

/**
 * Maršrutai, kurie PRIVALO reikalauti API rakto, kai jis nustatytas.
 *
 * `body` yra minimalus galiojantis kūnas - kad testas krastų dėl
 * autentifikacijos, o ne dėl validacijos.
 */
const PROTECTED = [
  { method: "post", path: "/api/generate", body: { transcript: "Jonas: Pakankamai ilgas tekstas testui." } },
  /**
   * `/api/jobs` su TEISINGU raktu realiai sukurtų ir paleistų jobą, tad
   * teigiamame teste jam duodam netinkamą kūną: autentifikacija praeina
   * (gaunam 400, ne 401), bet šalutinių efektų nelieka.
   */
  { method: "post", path: "/api/jobs", body: { transcript: "Jonas: Pakankamai ilgas tekstas testui." }, validBodyForAuthTest: { per: "trumpas" } },
  { method: "get", path: "/api/jobs/job_testas" },
  { method: "delete", path: "/api/jobs/job_testas" },
  {
    method: "post",
    path: "/api/exports",
    body: { variant: "redacted", format: "txt", protocol: { pavadinimas: "T" } },
  },
  { method: "get", path: "/api/transcribe-jobs/job_testas" },
  { method: "delete", path: "/api/transcribe-jobs/job_testas" },

  /**
   * MULTIPART maršrutai turi KITOKIĄ middleware seką:
   *   rate limit -> auth -> upload parser -> validation
   *
   * Todėl jų negalima laikyti padengtais vien todėl, kad JSON maršrutai
   * patikrinti: čia tarp autentifikacijos ir validacijos įsiterpia failo
   * skaitymas, ir klausimas „ar įkėlimas neprasideda prieš autentifikaciją"
   * yra atskiras.
   */
  { method: "post", path: "/api/transcribe", multipart: true },
  { method: "post", path: "/api/transcribe-jobs", multipart: true },
];

/**
 * SĄMONINGAI VIEŠI maršrutai.
 *
 * Kiekvienas čia yra sprendimas, ne praleidimas: orkestruotojo probe negali
 * reikalauti rakto, nes tada konteineris niekada netaptų sveikas.
 */
const PUBLIC = [
  { method: "get", path: "/api/health" },
  { method: "get", path: "/api/ready" },
];

function send({ method, path, body }, { key } = {}) {
  let req = request(app)[method](path);
  if (key) req = req.set("x-api-key", key);
  return body ? req.send(body) : req.send();
}

test("AUTENTIFIKACIJA: kiekvienas apsaugotas maršrutas be rakto grąžina 401", async () => {
  for (const route of PROTECTED) {
    const res = await send(route);

    assert.equal(
      res.status,
      401,
      `${route.method.toUpperCase()} ${route.path} turėjo grąžinti 401, gauta ${res.status}`
    );
  }
});

test("AUTENTIFIKACIJA: su teisingu raktu maršrutai nebeatmeta dėl autentifikacijos", async () => {
  for (const route of PROTECTED) {
    const res = await send(
      route.validBodyForAuthTest ? { ...route, body: route.validBodyForAuthTest } : route,
      { key: API_KEY }
    );

    // 400 (netinkamas kūnas), 404 (nėra jobo) ar 200 - visi reiškia, kad
    // autentifikacija praėjo. Svarbu tik tai, kad NE 401.
    assert.notEqual(res.status, 401, `${route.path}: teisingas raktas neturi būti atmestas`);
  }
});

test("AUTENTIFIKACIJA: neteisingas raktas atmetamas taip pat kaip trūkstamas", async () => {
  for (const route of PROTECTED) {
    const res = await send(route, { key: "neteisingas-raktas" });

    assert.equal(res.status, 401, `${route.path}: neteisingas raktas turi būti atmestas`);
  }
});

test("VIEŠI maršrutai lieka pasiekiami - probe negali reikalauti rakto", async () => {
  for (const route of PUBLIC) {
    const res = await send(route);

    assert.ok(res.status < 400, `${route.path} turi likti viešas, gauta ${res.status}`);
  }
});

test("MIDDLEWARE TVARKA: autentifikacija PIRMA - VISUOSE JSON maršrutuose", async () => {
  /**
   * Iki šiol tvarka buvo tik komentaras kode, o testas - tik `/api/exports`.
   * Sukeitus `validate` ir `apiKeyAuth` bet kuriame KITAME maršrute, nei
   * elgsenos, nei struktūrinis testas to nepagautų: struktūrinis tikrina tik
   * ar `apiKeyAuth` APSKRITAI yra, o abu žodžiai lieka eilutėje.
   *
   * Tvarka svarbi dviem kryptimis:
   *  - validacija pirma verstų schemas dirbti neautentifikuotam srautui, o
   *    klaidos pranešimas atskleistų API sutartį tam, kas neturi prieigos;
   *  - klientas gautų 400 vietoj 401 ir manytų, kad problema jo užklausoje.
   */
  const JSON_ROUTES = ["/api/generate", "/api/jobs", "/api/exports"];

  for (const path of JSON_ROUTES) {
    const res = await request(app).post(path).send({ visiskai: "netinkamas", kunas: true });

    assert.equal(res.status, 401, `${path}: be rakto turi būti 401, o ne validacijos 400`);
    assert.notEqual(
      res.body.code,
      "VALIDATION_FAILED",
      `${path}: validacija neturi būti vykdoma be autentifikacijos`
    );
  }
});

test("MIDDLEWARE TVARKA: multipart maršrutuose įkėlimas neprasideda prieš autentifikaciją", async () => {
  /**
   * Multipart kelyje tarp autentifikacijos ir validacijos įsiterpia failo
   * skaitymas. Jei jis vyktų pirma, neautentifikuotas klientas galėtų versti
   * serverį priimti failus - t. y. saugumo riba būtų UŽ brangiausios operacijos.
   *
   * Simptomas paprastas: be rakto ir be failo turi būti 401, o NE „trūksta
   * audio failo" 400.
   */
  for (const path of ["/api/transcribe", "/api/transcribe-jobs"]) {
    // Be failo užklausa nieko neįrodo: įkėlimo parseris tada nieko nedaro, ir
    // 401 grįžta nepriklausomai nuo tvarkos (pirmoji šio testo versija būtent
    // taip ir praeidavo su sukeista tvarka).
    //
    // Todėl siunčiam NELEIDŽIAMĄ failą: jei parseris eitų pirmas, jis atmestų
    // formatą su 400, ir tai matytųsi.
    const withFile = await request(app)
      .post(path)
      .attach("audio", Buffer.from("ne audio turinys"), {
        filename: "dokumentas.pdf",
        contentType: "application/pdf",
      });

    assert.equal(
      withFile.status,
      401,
      `${path}: neleidžiamas failas be rakto turi duoti 401, o ne įkėlimo 400 - ` +
        "priešingu atveju įkėlimas vyksta PRIEŠ autentifikaciją"
    );

    const serialized = JSON.stringify(withFile.body);
    assert.ok(!/formatas|mime|audio/i.test(serialized), `${path}: įkėlimo detalės neturi nutekėti: ${serialized}`);

    // Ir be failo taip pat 401, o ne „trūksta audio failo".
    const withoutFile = await request(app).post(path).send();
    assert.equal(withoutFile.status, 401, `${path}: be rakto ir be failo turi būti 401`);
  }
});

test("VALIDACIJA: su raktu netinkamas kūnas duoda 400 su vienu formatu", async () => {
  const res = await request(app)
    .post("/api/exports")
    .set("x-api-key", API_KEY)
    .send({ visiskai: "netinkamas" });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_FAILED");
  assert.ok(Array.isArray(res.body.details));
});

test("KLAIDOS: 401 atsakyme nėra nei rakto, nei vidinių detalių", async () => {
  const res = await send(PROTECTED[0], { key: "neteisingas-raktas-su-slaptu-tekstu" });

  const serialized = JSON.stringify(res.body);

  assert.ok(!serialized.includes(API_KEY), "tikrasis raktas negali nutekėti");
  assert.ok(!serialized.includes("neteisingas-raktas-su-slaptu"), "pateiktas raktas negali grįžti atgal");
  assert.ok(!serialized.includes("/home/"), "vietiniai keliai negali patekti į atsakymą");
  assert.ok(!/\bat \w+ \(/.test(serialized), "jokio stack trace");
});

test("STRUKTŪRA: nė vienas maršrutas su įvestimi neliko be apiKeyAuth", () => {
  /**
   * Elgsenos testas dengia žinomus maršrutus; šis - būsimus.
   *
   * Naujas maršrutas be `apiKeyAuth` praeitų visus aukščiau esančius testus,
   * nes jų sąraše jo tiesiog nebūtų. Struktūrinė patikra tai pagauna nepaisant
   * to, ar kas nors prisiminė papildyti sąrašą.
   */
  const fs = require("fs");
  const path = require("path");
  const routesDir = path.join(__dirname, "../routes");

  /** Maršrutai, kurie sąmoningai vieši arba turi SAVO autentifikaciją. */
  const EXEMPT = {
    "audit.js": ["auditAuth"], // atskiras AUDIT_API_KEY
    /**
     * auth.js (#18 PR1) SĄMONINGAI be apiKeyAuth: prisijungimo endpoint'as
     * PATS yra autentifikacijos mechanizmas - jam reikalauti API rakto būtų
     * apskritai neįmanoma (vartotojas dar neturi sesijos). Apsaugotas kitaip:
     * loginIpLimiter + loginAccountLimiter (bandymų ribojimas) ir
     * requireSession (/me).
     */
    "auth.js": ["loginIpLimiter", "loginAccountLimiter", "requireSession", "logout"], // logout tikslingai idempotentinis be sesijos
  };

  const offenders = [];

  for (const file of fs.readdirSync(routesDir)) {
    if (!file.endsWith(".js")) continue;

    const source = fs.readFileSync(path.join(routesDir, file), "utf8");
    const routes = source.match(/router\.(get|post|delete|put|patch)\([\s\S]{0,400}?=>/g) || [];

    for (const route of routes) {
      const exemptGuards = EXEMPT[file] || [];
      const guarded = /apiKeyAuth/.test(route) || exemptGuards.some((guard) => route.includes(guard));

      if (!guarded) offenders.push(`${file}: ${route.split("\n")[0].slice(0, 70)}`);
    }
  }

  assert.deepEqual(offenders, [], `maršrutai be autentifikacijos:\n${offenders.join("\n")}`);
});
