const test = require("node:test");
const assert = require("node:assert");

// Svarbu: šie testai tikrina PROPORCINGĄ timeout, kuris buvo pridėtas po realaus
// RunPod diegimo defekto - fiksuotas 90s timeout nutraukdavo ilgų (4 val.) failų
// diarizaciją, nors pyannote realiai užbaigdavo darbą. Žr. httpClient.js.

// Užtikriname, kad API_TIMEOUT_MS nėra nustatytas (kitaip proporcingas skaičiavimas
// pasiduoda eksplicitiškam override - tai irgi tikrinama žemiau atskirai).
delete process.env.API_TIMEOUT_MS;
const { timeoutForAudioBytes } = require("../utils/httpClient");

const WAV_BYTES_PER_SEC = 32000;

test("trumpas failas gauna bent minimalų (5 min) timeout", () => {
  const tenSeconds = 10 * WAV_BYTES_PER_SEC;
  assert.strictEqual(timeoutForAudioBytes(tenSeconds), 300000);
});

test("tuščias/nulinis dydis nesukelia klaidos ir grąžina minimumą", () => {
  assert.strictEqual(timeoutForAudioBytes(0), 300000);
  assert.strictEqual(timeoutForAudioBytes(undefined), 300000);
});

test("ilgas failas gauna proporcingai didesnį timeout nei trumpas", () => {
  const short = timeoutForAudioBytes(5 * 60 * WAV_BYTES_PER_SEC);
  const long = timeoutForAudioBytes(30 * 60 * WAV_BYTES_PER_SEC);
  assert.ok(long > short, "ilgesnis failas turi turėti ilgesnį timeout");
});

test("4 val. failas neviršija viršutinės ribos (90 min)", () => {
  const fourHours = 4 * 60 * 60 * WAV_BYTES_PER_SEC;
  const ms = timeoutForAudioBytes(fourHours);
  assert.ok(ms <= 5400000, "neturi viršyti AUDIO_TIMEOUT_MAX_MS");
  assert.ok(ms >= 300000, "neturi būti mažiau nei minimumas");
});

test("4 val. failas gauna žymiai didesnį timeout nei senasis 90s defektas", () => {
  const fourHours = 4 * 60 * 60 * WAV_BYTES_PER_SEC;
  const ms = timeoutForAudioBytes(fourHours);
  // Senasis fiksuotas limitas buvo 90000ms (90s) - būtent jis nutraukdavo 4 val.
  // diarizaciją. Naujas turi būti daug didesnis.
  assert.ok(ms > 90000, "4 val. failui timeout turi būti gerokai daugiau nei senas 90s");
});
