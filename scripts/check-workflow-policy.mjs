#!/usr/bin/env node
/**
 * WORKFLOW SAUGUMO POLITIKOS PATIKRA (#16).
 *
 * Politika, kurios niekas netikrina, galioja tik tol, kol visi ją prisimena.
 * Šis skriptas paverčia `docs/ci-security-policy.md` taisykles vykdomomis:
 * pažeidimas sulaužo CI, o ne laukia peržiūros.
 *
 * Tikrina TIK tai, ką galima patikrinti statiškai. Dalykai, reikalaujantys
 * sprendimo (ar šiam job'ui tikrai reikia `packages: write`), lieka žmogui.
 *
 * Naudojimas: node scripts/check-workflow-policy.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/**
 * `yaml` gyvena `backend/node_modules`, o skriptas paleidžiamas iš repo šaknies.
 *
 * Naudojam Node modulių paiešką, o NE kietą kelią į `dist/index.js`: pastarasis
 * lūžtų pakeitus paketo vidinę struktūrą, npm hoisting'ą ar pridėjus workspaces -
 * ir lūžtų tyliai, nes CI job'as tada kristų su „module not found", o ne su
 * politikos pažeidimu.
 */
const here = dirname(fileURLToPath(import.meta.url));
const requireFromBackend = createRequire(join(here, "..", "backend", "package.json"));

let parse;
try {
  ({ parse } = requireFromBackend("yaml"));
} catch (e) {
  console.error(
    "Nepavyko įkelti `yaml` paketo. Paleiskite `npm ci` kataloge backend/ prieš šį skriptą.\n" +
      `Priežastis: ${e.message}`
  );
  process.exit(2);
}

const WORKFLOW_DIR = ".github/workflows";
const DEPENDABOT = ".github/dependabot.yml";

/** Leidėjai, kuriems pakanka major tag'o. Visiems kitiems - pilnas SHA. */
const TRUSTED_PUBLISHERS = ["actions/", "docker/", "github/"];

/**
 * Job'ai, kuriems LEIDŽIAMOS write teisės, ir kokios.
 *
 * Allow-list, o ne „bet kas job lygiu": priešingu atveju politika reikštų tik
 * „nerašyk write workflow lygiu", ir bet kuris naujas job galėtų pasiimti bet
 * ką. Kiekvienas įrašas čia yra sąmoningas sprendimas, matomas peržiūroje.
 */
const ALLOWED_JOB_WRITES = {
  "publish-images.yml": { "build-and-push": ["packages"] },
  "gemini-pre-review.yml": { publish: ["issues"] },
};

/** Privalomos dependabot poros: ekosistema + katalogas. */
const REQUIRED_DEPENDABOT = [
  ["npm", "/backend"],
  ["npm", "/frontend"],
  ["pip", "/backend/scripts"],
  ["pip", "/pyannote-server"],
  ["pip", "/whisper-server"],
  ["github-actions", "/"],
];

const problems = [];

function fail(file, message) {
  problems.push(`${file}: ${message}`);
}

/**
 * `dependabot.yml` SINTAKSĖ.
 *
 * Rasta rašant #16: viename įraše trūko tarpo po dvitaškio
 * (`open-pull-requests-limit:5`). GitHub tokį failą atmeta TYLIAI - nė viena
 * priklausomybė nebuvo tikrinama, o repozitorijoje niekas apie tai nepranešė.
 * Būtent todėl ši patikra yra pirma.
 */
function checkDependabot() {
  if (!existsSync(DEPENDABOT)) {
    fail(DEPENDABOT, "failo nėra - priklausomybės neatnaujinamos");
    return;
  }

  let config;
  try {
    config = parse(readFileSync(DEPENDABOT, "utf8"));
  } catch (e) {
    fail(DEPENDABOT, `neteisinga YAML sintaksė (GitHub tokį failą atmeta tyliai): ${e.message}`);
    return;
  }

  /**
   * Tikrinamos POROS, ne tik ekosistemos.
   *
   * Vien „ar yra npm" praeitų ir ištrynus `/frontend` įrašą - liktų `/backend`,
   * ir patikra būtų žalia, nors pusė kodo nebeskenuojama.
   */
  const present = new Set(
    (config.updates || []).map((u) => `${u["package-ecosystem"]}::${u.directory}`)
  );

  for (const [ecosystem, directory] of REQUIRED_DEPENDABOT) {
    if (!present.has(`${ecosystem}::${directory}`)) {
      fail(DEPENDABOT, `trūksta įrašo: ${ecosystem} ties "${directory}"`);
    }
  }

  for (const update of config.updates || []) {
    const limit = update["open-pull-requests-limit"];
    if (limit !== undefined && !Number.isInteger(limit)) {
      fail(DEPENDABOT, `open-pull-requests-limit turi būti skaičius, gauta: ${JSON.stringify(limit)}`);
    }
  }
}

/**
 * Paslaptys turi būti perduodamos ŽINGSNIUI, ne job'ui ar workflow.
 *
 * Platesnis `env` padaro paslaptį matomą kiekvienam žingsniui, įskaitant
 * trečiųjų šalių action'us, kurie apie ją neturėtų žinoti. Iki šiol tai buvo tik
 * dokumento taisyklė - t. y. galiojo, kol visi ją prisimena.
 */
function checkSecretPlacement(file, scope, env) {
  if (!env || typeof env !== "object") return;

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.includes("secrets.")) {
      fail(file, `${scope} lygio \`env.${key}\` turi paslaptį - perduokite ją tik tam žingsniui, kuriam reikia`);
    }
  }
}

function checkWorkflow(file) {
  const path = join(WORKFLOW_DIR, file);
  let workflow;

  try {
    workflow = parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(file, `neteisinga YAML sintaksė: ${e.message}`);
    return;
  }

  // 1. Eksplicitinis workflow lygio permissions blokas.
  //
  // `permissions: {}` yra GALIOJANTIS ir griežčiausias variantas (jokių teisių),
  // tad tikrinam raktą, o ne reikšmės „tiesą" - `{}` JS'e truthy, bet `null`
  // (t. y. `permissions:` be reikšmės) - ne, ir toks blokas nieko nenustato.
  if (!("permissions" in workflow) || workflow.permissions === null) {
    fail(file, "nėra workflow lygio `permissions` bloko - job'ai paveldėtų repo numatytąsias teises");
  } else if (workflow.permissions === "write-all") {
    fail(file, "`write-all` neleidžiamas niekada");
  } else if (typeof workflow.permissions === "object") {
    /**
     * WORKFLOW lygiu jokia `write` teisė neleidžiama.
     *
     * Iki šiol tikrinom tik `write-all`, tad `contents: write` + `issues: write`
     * praeidavo - nors tai lygiai tas pats pažeidimas, tik surašytas eilutėmis.
     * Write teisės izoliuojamos JOB lygiu, kur matyti, kam konkrečiai jų reikia.
     */
    for (const [scope, level] of Object.entries(workflow.permissions)) {
      if (level === "write") {
        fail(
          file,
          `workflow lygio \`${scope}: write\` neleidžiamas - write teisės izoliuojamos job lygiu`
        );
      }
    }
  }

  // Paslaptys workflow lygio `env` matomos KIEKVIENAM žingsniui, įskaitant
  // trečiųjų šalių action'us.
  checkSecretPlacement(file, "workflow", workflow.env);

  /**
   * 2. `pull_request_target` neturi vykdyti PR kodo.
   *
   * YAML 1.1 `on` būtų buvęs boolean `true`; `yaml` v2 naudoja YAML 1.2, kur jis
   * lieka eilute. Tikrinam ABU pavidalus eksplicitiškai - kitaip patikra tyliai
   * nustotų veikti pakeitus parserį, ir niekas to nepastebėtų, nes ji ir
   * veikdama nieko nerodo.
   */
  const triggers = workflow.on ?? workflow[true] ?? {};
  const triggerNames = Array.isArray(triggers)
    ? triggers
    : typeof triggers === "string"
      ? [triggers]
      : Object.keys(triggers || {});

  if (triggerNames.includes("pull_request_target")) {
    fail(
      file,
      "naudojamas `pull_request_target` - jis turi prieigą prie paslapčių; " +
        "žr. docs/ci-security-policy.md prieš pridedant"
    );
  }

  for (const [name, job] of Object.entries(workflow.jobs || {})) {
    // Job lygio `env` su paslaptimi matoma visiems to job'o žingsniams.
    checkSecretPlacement(file, `job "${name}"`, job.env);

    /**
     * `secrets: inherit` perduoda VISAS repo paslaptis panaudojamam workflow -
     * įskaitant tas, apie kurias jis nieko nežino. Perdavimas turi būti
     * eksplicitinis, po vieną.
     */
    if (job.secrets === "inherit") {
      fail(file, `job "${name}": \`secrets: inherit\` perduoda VISAS paslaptis - nurodykite jas po vieną`);
    }

    // Job lygio write teisės - tik pagal allow-list.
    if (job.permissions && typeof job.permissions === "object") {
      const allowed = ALLOWED_JOB_WRITES[file]?.[name] || [];

      for (const [scope, level] of Object.entries(job.permissions)) {
        if (level === "write" && !allowed.includes(scope)) {
          fail(
            file,
            `job "${name}": \`${scope}: write\` nėra allow-list'e ` +
              "(scripts/check-workflow-policy.mjs ALLOWED_JOB_WRITES)"
          );
        }
      }
    }
    /**
     * PANAUDOJAMI WORKFLOW (`jobs.<id>.uses`) neturi `steps` ir gali turėti savo
     * `permissions` bei nepatikimą šaltinį. Iki šiol patikra jų nematė visai -
     * job'as be `steps` tiesiog pralėkdavo pro visus žingsnių ciklus.
     */
    if (job.uses) {
      const trusted = TRUSTED_PUBLISHERS.some((prefix) => job.uses.startsWith(prefix));
      const local = job.uses.startsWith("./");
      const pinnedToSha = /@[0-9a-f]{40}$/.test(job.uses);

      if (!local && !trusted && !pinnedToSha) {
        fail(file, `job "${name}": panaudojamas workflow "${job.uses}" turi būti prisegtas prie SHA`);
      }
      // `timeout-minutes` panaudojamam workflow netaikomas - jį nustato pats
      // iškviečiamas workflow, tad reikalauti jo čia būtų klaidinga.
      continue;
    }

    // 3. Kiekvienas job turi laiko ribą.
    if (!job["timeout-minutes"]) {
      fail(file, `job "${name}" neturi timeout-minutes (numatytoji GitHub riba - 6 val.)`);
    }

    // 4. write teisės tik ten, kur jos aiškiai nurodytos job lygiu.
    if (job.permissions === "write-all") {
      fail(file, `job "${name}": \`write-all\` neleidžiamas`);
    }

    for (const step of job.steps || []) {
      // 5. Trečiųjų šalių action'ai prisegami pagal politiką.
      if (step.uses && !step.uses.startsWith("./")) {
        const trusted = TRUSTED_PUBLISHERS.some((prefix) => step.uses.startsWith(prefix));
        const pinnedToSha = /@[0-9a-f]{40}$/.test(step.uses);

        if (!trusted && !pinnedToSha) {
          fail(
            file,
            `job "${name}": action "${step.uses}" iš nepatikrinto leidėjo turi būti prisegtas prie SHA`
          );
        }
      }

      // Paslaptys žingsnio lygiu - LEIDŽIAMOS, tai ir yra teisinga vieta.

      /**
       * `actions/checkout` palieka `GITHUB_TOKEN` git konfigūracijoje, tad bet
       * kuris vėlesnis žingsnis (įskaitant trečiųjų šalių) gali juo pasinaudoti.
       * Testiniams job'ams push'inti nereikia.
       */
      if (step.uses && step.uses.startsWith("actions/checkout")) {
        if (step.with?.["persist-credentials"] !== false) {
          fail(
            file,
            `job "${name}": checkout be \`persist-credentials: false\` - ` +
              "GITHUB_TOKEN liktų git konfigūracijoje"
          );
        }
      }

      // 6. Artefaktai turi eksplicitinę retenciją.
      if (step.uses && step.uses.startsWith("actions/upload-artifact") && !step.with?.["retention-days"]) {
        fail(file, `job "${name}": upload-artifact be \`retention-days\` (numatytoji - 90 d.)`);
      }
    }
  }
}

checkDependabot();

for (const file of readdirSync(WORKFLOW_DIR)) {
  if (file.endsWith(".yml") || file.endsWith(".yaml")) checkWorkflow(file);
}

if (problems.length > 0) {
  console.error("Workflow saugumo politikos pažeidimai:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nŽr. docs/ci-security-policy.md");
  process.exit(1);
}

console.log("Workflow saugumo politika: viskas tvarkoje.");
