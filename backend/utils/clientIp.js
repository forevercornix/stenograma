const crypto = require("crypto");

/**
 * KLIENTO IP IR PROXY PASITIKĖJIMAS (GDPR #17).
 *
 * IP adresas yra asmens duomuo. Jis reikalingas piktnaudžiavimo signalams (rate
 * limitas), bet neturi gulti į ilgaamžius logus - būtent tą skirtumą šis modulis
 * ir įgyvendina: tikras IP naudojamas trumpalaikiam sprendimui, o į logus ir
 * auditą keliauja tik pseudonimas.
 *
 * `trust proxy` KONFIGŪRUOJAMAS EKSPLICITIŠKAI.
 *
 * Numatytoji Express reikšmė yra `false`, ir tai teisinga tiesioginiam
 * diegimui. Bet už nginx/RunPod proxy tada VISI klientai atrodo kaip
 * `127.0.0.1`: rate limitas tampa bendras visiems, ir vieno naudotojo srautas
 * užblokuoja likusius. Priešingas kraštutinumas - aklas `true` - leistų bet kam
 * suklastoti `X-Forwarded-For` ir apeiti limitą.
 *
 * Todėl reikšmė imama iš `TRUST_PROXY`, o numatytoji parenkama sąmoningai
 * pagal diegimo scenarijų, ne spėjimu.
 */

/**
 * @returns {boolean|number|string} reikšmė, tinkama `app.set("trust proxy", …)`
 */
function resolveTrustProxy(env = process.env) {
  const raw = String(env.TRUST_PROXY ?? "").trim();

  if (raw === "") {
    // Numatytai NEPASITIKIMA: klaidingas pasitikėjimas yra saugumo spraga, o
    // klaidingas nepasitikėjimas - tik nepatogumas, kurį matyti iš karto.
    return false;
  }

  if (raw === "true") return true;
  if (raw === "false") return false;

  // Skaičius = kiek proxy „šuolių" priešais mus (nginx = 1). Tai saugiausia
  // forma: pasitikima tik tiek, kiek realiai yra infrastruktūros.
  if (/^\d+$/.test(raw)) return Number(raw);

  // IP arba CIDR sąrašas - eksplicitiškiausias variantas.
  return raw;
}

/**
 * IP pseudonimas logams ir auditui.
 *
 * Saugom HMAC su proceso druska, ne patį adresą. Tai leidžia atsakyti į
 * klausimą „ar tai tas pats klientas?", bet neleidžia atkurti adreso - t. y.
 * tiksliai tiek, kiek reikia piktnaudžiavimo signalams.
 *
 * Druska ta pati, kaip audito pseudonimams (`AUDIT_ID_SALT`): be jos
 * generuojama atsitiktinė proceso druska, tad po restarto pseudonimai
 * pasikeičia. Ilgaamžiam sekimui tai apribojimas, bet privatumui - privalumas,
 * ir jis dokumentuotas.
 */
function pseudonymizeIp(ip, env = process.env) {
  if (typeof ip !== "string" || ip.trim() === "") return null;

  const salt = env.AUDIT_ID_SALT || _processSalt();
  return `ip_${crypto.createHmac("sha256", salt).update(ip.trim()).digest("hex").slice(0, 12)}`;
}

let _salt = null;
function _processSalt() {
  if (!_salt) _salt = crypto.randomBytes(32).toString("hex");
  return _salt;
}

/**
 * Tinklo dalis be paskutinio okteto (IPv4) arba be interfeiso dalies (IPv6).
 *
 * Naudinga geografinei/tinklo diagnostikai ten, kur pseudonimo neužtenka.
 * NĖRA numatytasis kelias - `pseudonymizeIp()` saugesnis, o šis paliekamas
 * sąmoningam pasirinkimui.
 */
function truncateIp(ip) {
  if (typeof ip !== "string" || ip.trim() === "") return null;

  const value = ip.trim().replace(/^::ffff:/i, "");

  if (value.includes(":")) return _truncateIpv6(value);

  const octets = value.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return null;

  return `${octets.slice(0, 3).join(".")}.0/24`;
}

/**
 * IPv6 /64 tinklas.
 *
 * Pirminė versija darė `split(":").slice(0, 4)`, kas SUGLAUSTOMS formoms duoda
 * neteisingą atsakymą: `2001:db8::1` turi tik tris dalis, tad rezultatas būtų
 * `2001:db8::/64` atsitiktinai teisingas, o `fe80::1%eth0` ar `::1` - visiškai
 * ne. Todėl adresas pirma IŠSKLEIDŽIAMAS iki aštuonių grupių.
 */
function _truncateIpv6(value) {
  const address = value.split("%")[0];
  const halves = address.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];

  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;

  const groups = halves.length === 2 ? [...head, ...Array(missing).fill("0"), ...tail] : head;

  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;

  return `${groups.slice(0, 4).map((g) => g.toLowerCase()).join(":")}::/64`;
}

module.exports = { resolveTrustProxy, pseudonymizeIp, truncateIp };
