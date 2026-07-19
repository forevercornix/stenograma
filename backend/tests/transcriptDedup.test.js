const test = require("node:test");
const assert = require("node:assert/strict");
const { dedupTranscriptText, dedupSegments } = require("../utils/transcriptDedup");

test("dedup: ilga identiškų eilučių serija (realus Whisper haliucinacijos šablonas) sutraukiama į vieną + žymę", () => {
  const line = "Čia mum ir iš Vaiko gerovės komisijos ir atkeliavo štas klausimas iš tikrųjų.";
  const text = Array(280).fill(line).join("\n");
  const r = dedupTranscriptText(text);
  assert.equal(r.collapsedRuns, 1);
  assert.equal(r.removedItems, 279);
  assert.match(r.text, /kartojosi 280 kartus/);
  assert.ok(r.dedupedLength < r.originalLength / 50, "turėtų sumažėti dešimtimis kartų");
});

test("dedup: trumpos serijos (< 3) NELIEČIAMOS - dvigubas pakartojimas realioje kalboje normalus", () => {
  const text = "Labas.\nLabas.\nKaip sekasi?";
  const r = dedupTranscriptText(text);
  assert.equal(r.collapsedRuns, 0);
  assert.equal(r.text, text);
});

test("dedup: žymė išsaugo pasikartojimo skaičių (pvz. balsavimo 'Taip.' x30 - LLM žinos, kad balsavo daug)", () => {
  const text = ["Kas už tai? Kelkime rankas.", ...Array(30).fill("Taip."), "Puiku, priimta."].join("\n");
  const r = dedupTranscriptText(text);
  assert.equal(r.collapsedRuns, 1);
  assert.match(r.text, /Taip\./);
  assert.match(r.text, /kartojosi 30 kartus/);
  assert.match(r.text, /Puiku, priimta/);
});

test("dedup: NE gretimi pasikartojimai (ta pati frazė skirtingose vietose) neliečiami", () => {
  const text = "Ačiū.\nKitas klausimas.\nAčiū.\nDar vienas.\nAčiū.";
  const r = dedupTranscriptText(text);
  assert.equal(r.collapsedRuns, 0);
});

test("dedup: vientisas tekstas be eilučių skaidomas sakiniais ir taip pat sutraukiamas", () => {
  const text = "Pradžia. " + Array(10).fill("Tas pats sakinys.").join(" ") + " Pabaiga.";
  const r = dedupTranscriptText(text);
  assert.equal(r.collapsedRuns, 1);
  assert.match(r.text, /kartojosi 10 kartus/);
  assert.match(r.text, /Pradžia\./);
  assert.match(r.text, /Pabaiga\./);
});

test("dedupSegments: sutraukta serija išlaiko pirmo start ir paskutinio end (laiko aprėptis neprarandama)", () => {
  const segs = [
    { start: 0, end: 10, text: "Įžanga." },
    ...Array.from({ length: 50 }, (_, i) => ({ start: 10 + i * 30, end: 40 + i * 30, text: "Kartojama frazė." })),
    { start: 2000, end: 2010, text: "Pabaiga." },
  ];
  const r = dedupSegments(segs);
  assert.equal(r.segments.length, 3);
  assert.equal(r.segments[1].start, 10);
  assert.equal(r.segments[1].end, 40 + 49 * 30);
  assert.match(r.segments[1].text, /kartojosi 50 kartus/);
});

test("dedup: tuščias/null įvestis apdorojama gracingai", () => {
  assert.equal(dedupTranscriptText("").text, "");
  assert.equal(dedupTranscriptText(null).text, "");
  assert.deepEqual(dedupSegments([]).segments, []);
});
