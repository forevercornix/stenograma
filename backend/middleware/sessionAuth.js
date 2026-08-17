const sessionStore = require("../utils/sessionStore");
const { setActor } = require("../utils/requestContext");


/**
 * SESIJOS AUTENTIFIKACIJA (#18 PR1).
 *
 * Šis middleware yra NAUJAS ir ATSKIRAS nuo `apiKeyAuth`. Jis NEPAKEIČIA
 * esamo bendro API_KEY maršrutuose (`/api/generate`, `/api/exports` ir t. t.) -
 * tai #18 PR2 darbas (rolėmis grįsta autorizacija). Šio PR tikslas siauresnis:
 * patikimai atsakyti į klausimą „kas prašo", ne „ką jam leidžiama".
 *
 * KODĖL BE `cookie-parser`: reikalingas tik vienas skaitymas iš vieno
 * antraštės lauko - papildoma priklausomybė nepridėtų nieko, ko nepadarytų
 * 10 eilučių. Ta pati logika, kuria vadovaujamasi visur šiame projekte (žr.
 * `utils/logger.js` – savas modulis vietoj pino).
 */

const COOKIE_NAME = "stenograma_sid";

/** Parsina VIENĄ cookie reikšmę iš `Cookie` antraštės, be trečiųjų šalių paketo. */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;

    /**
     * FAIL-CLOSED: `decodeURIComponent` meta `URIError` su blogai
     * suformuotu procentiniu kodavimu (pvz. `%E0%A4%A`).
     *
     * Be try/catch klientas, atsiuntęs suklastotą cookie, gautų NEIŠGAUTĄ
     * klaidą - 500, o ne deklaruotą vienodą 401 `SESSION_REQUIRED`. Sugadinta
     * cookie reiškia "sesijos nėra", ne "serverio klaida".
     */
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Nustato sesijos cookie.
 *
 * `HttpOnly` - JavaScript negali jos perskaityti (XSS negali jos pavogti).
 * `SameSite=Lax` - pakanka to paties domeno diegimui (patvirtinta #18
 * sprendime), o griežtesnis `Strict` sulaužytų nuorodas iš el. laiškų ir pan.
 * `Secure` - TIK produkcijoje: lokaliam HTTP kūrimui priverstinis Secure
 * reikštų, kad cookie niekada nebūtų išsiųsta, ir prisijungimas tyliai
 * neveiktų.
 */
function setSessionCookie(res, sessionId, maxAgeMs) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
      maxAgeMs / 1000
    )}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

/**
 * VIENODAS 401 atsakymas – tas pats pranešimas nepriklausomai nuo priežasties
 * (nėra cookie, sesija pasibaigusi, sesija nežinoma). Skirtingi pranešimai
 * kiekvienam atvejui leistų klientui atskirti „niekada neprisijungiau" nuo
 * „sesija pasibaigė" – naudingos informacijos daugiau, nei reikia.
 */
function unauthorized(res) {
  return res.status(401).json({ error: "Reikalingas prisijungimas.", code: "SESSION_REQUIRED" });
}

/**
 * PRIVALOMA sesija – naudoti maršrutuose, kuriems būtinas žinomas vartotojas.
 */
async function requireSession(req, res, next) {
  const sessionId = readCookie(req, COOKIE_NAME);
  const session = await sessionStore.touch(sessionId);

  if (!session) return unauthorized(res);

  // `id` - stabili tapatybė (#158); `username` lieka auditui ir logams.
  req.user = { id: session.userId || null, username: session.username, role: session.role };
  // AKTORIUS audito įrašams - vartotojo vardas, ne sesijos ID (žr. GDPR #17
  // requestContext modelį; scrypt atspaudas čia neprasmingas, nes vardas pats
  // savaime nėra paslaptis, kaip API raktas).
  setActor(session.username);

  next();
}

/**
 * NEPRIVALOMA sesija – `req.user` bus `null`, jei sesijos nėra, bet užklausa
 * praeina toliau. Naudinga viešiems maršrutams, kuriems naudinga žinoti
 * vartotoją, jei jis yra, bet nereikalauti to.
 */
async function optionalSession(req, res, next) {
  const sessionId = readCookie(req, COOKIE_NAME);
  const session = await sessionStore.touch(sessionId);

  req.user = session
    ? { id: session.userId || null, username: session.username, role: session.role }
    : null;
  if (session) setActor(session.username);

  next();
}

module.exports = {
  requireSession,
  optionalSession,
  setSessionCookie,
  clearSessionCookie,
  readCookie,
  COOKIE_NAME,
};
