const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeDiarization } = require("../utils/mergeDiarization");

test("mergeDiarization: priskiria kalbėtoją pagal didžiausią laiko persidengimą", () => {
  const segments = [
    { start: 0, end: 4, text: "A" },
    { start: 4, end: 9, text: "B" },
  ];
  const turns = [
    { start: 0, end: 4.5, speaker: "Kalbėtojas 1" },
    { start: 4.5, end: 10, speaker: "Kalbėtojas 2" },
  ];
  const result = mergeDiarization(segments, turns);
  assert.equal(result[0].speaker, "Kalbėtojas 1");
  assert.equal(result[1].speaker, "Kalbėtojas 2"); // 4-4.5 persidengia su 1, bet 4.5-9 su 2 (daugiau)
});

test("mergeDiarization: segmentas be jokio persidengimo lieka null", () => {
  const segments = [{ start: 100, end: 110, text: "izoliuotas" }];
  const turns = [{ start: 0, end: 10, speaker: "Kalbėtojas 1" }];
  const result = mergeDiarization(segments, turns);
  assert.equal(result[0].speaker, null);
});

test("mergeDiarization: tuščias turns masyvas grąžina segmentus nepakeistus", () => {
  const segments = [{ start: 0, end: 4, text: "A", speaker: "originalus" }];
  const result = mergeDiarization(segments, []);
  assert.equal(result[0].speaker, "originalus");
});

test("mergeDiarization: originalus segmento speaker išsaugomas, jei nėra persidengimo, bet jis jau buvo užpildytas", () => {
  const segments = [{ start: 50, end: 55, text: "A", speaker: "Jonas" }];
  const turns = [{ start: 0, end: 10, speaker: "Kalbėtojas 1" }];
  const result = mergeDiarization(segments, turns);
  assert.equal(result[0].speaker, "Jonas");
});

test("mergeDiarization: nesugadina segmentų, jei turns nėra masyvas", () => {
  const segments = [{ start: 0, end: 4, text: "A" }];
  const result = mergeDiarization(segments, null);
  assert.deepEqual(result, segments);
});
