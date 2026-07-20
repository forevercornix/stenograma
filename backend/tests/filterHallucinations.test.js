const test = require("node:test");
const assert = require("node:assert");
const { filterHallucinations, looksLikeHallucination } = require("../utils/filterHallucinations");

test("pašalina youtube halucinaciją be kalbėtojo (diarized)", () => {
  const segs = [
    { start: 0, end: 2, text: "Sveiki visi", speaker: "SPEAKER_00" },
    { start: 2, end: 4, text: "www.youtube.com", speaker: null },
    { start: 4, end: 6, text: "Pradedam posėdį", speaker: "SPEAKER_01" },
  ];
  const r = filterHallucinations(segs, { diarized: true });
  assert.equal(r.removed, 1);
  assert.equal(r.segments.length, 2);
  assert.ok(!r.text.includes("youtube"));
});

test("NELIEČIA youtube segmento, jei jam PRISKIRTAS kalbėtojas (diarized)", () => {
  // Jei realus žmogus pasakė "youtube", pyannote priskyrė kalbėtoją - neliečiam.
  const segs = [
    { start: 0, end: 2, text: "aplankykit mūsų youtube kanalą", speaker: "SPEAKER_00" },
  ];
  const r = filterHallucinations(segs, { diarized: true });
  assert.equal(r.removed, 0);
  assert.equal(r.segments.length, 1);
});

test("be diarizacijos filtruoja pagal šabloną (nėra speaker info)", () => {
  const segs = [
    { start: 0, end: 2, text: "Realus tekstas" },
    { start: 2, end: 4, text: "www.youtube.come" },
  ];
  const r = filterHallucinations(segs, { diarized: false });
  assert.equal(r.removed, 1);
  assert.equal(r.segments.length, 1);
});

test("šalina tuščius segmentus be kalbėtojo", () => {
  const segs = [
    { start: 0, end: 2, text: "   ", speaker: null },
    { start: 2, end: 4, text: "Tikras", speaker: "SPEAKER_00" },
  ];
  const r = filterHallucinations(segs, { diarized: true });
  assert.equal(r.removed, 1);
});

test("FILTER_HALLUCINATIONS=false išjungia filtrą", () => {
  process.env.FILTER_HALLUCINATIONS = "false";
  const segs = [{ start: 0, end: 2, text: "www.youtube.com", speaker: null }];
  const r = filterHallucinations(segs, { diarized: true });
  assert.equal(r.removed, 0);
  delete process.env.FILTER_HALLUCINATIONS;
});

test("looksLikeHallucination atpažįsta tuščią ir žinomus šablonus", () => {
  assert.equal(looksLikeHallucination("", []), true);
  assert.equal(looksLikeHallucination("Normalus sakinys", []), false);
});
