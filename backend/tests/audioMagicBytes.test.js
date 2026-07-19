const test = require("node:test");
const assert = require("node:assert/strict");
const { detectAudioMagic } = require("../utils/audioMagicBytes");
const { fakeMp3Buffer, fakeWavBuffer } = require("./helpers/fakeAudio");

test("detectAudioMagic: atpažįsta MP3 (ID3 antraštė)", () => {
  assert.equal(detectAudioMagic(fakeMp3Buffer()), "mp3");
});

test("detectAudioMagic: atpažįsta WAV (RIFF/WAVE antraštė)", () => {
  assert.equal(detectAudioMagic(fakeWavBuffer()), "wav");
});

test("detectAudioMagic: atpažįsta OGG", () => {
  assert.equal(detectAudioMagic(Buffer.from("OggS papildomas turinys")), "ogg");
});

test("detectAudioMagic: atpažįsta FLAC", () => {
  assert.equal(detectAudioMagic(Buffer.from("fLaC papildomas turinys")), "flac");
});

test("detectAudioMagic: atpažįsta WebM (EBML antraštė)", () => {
  const buf = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("papildomas turinys")]);
  assert.equal(detectAudioMagic(buf), "webm");
});

test("detectAudioMagic: grąžina null tekstiniam failui, pervadintam į .mp3 (rename bypass bandymas)", () => {
  const fakeTxtRenamedToMp3 = Buffer.from("Tai tiesiog paprastas tekstinis failas, ne audio.");
  assert.equal(detectAudioMagic(fakeTxtRenamedToMp3), null);
});

test("detectAudioMagic: grąžina null per trumpam/tuščiam buferiui", () => {
  assert.equal(detectAudioMagic(Buffer.alloc(0)), null);
  assert.equal(detectAudioMagic(null), null);
});
