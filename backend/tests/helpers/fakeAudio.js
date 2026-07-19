// Minimalus buferis su tikra MP3 "ID3" antrašte - naudojamas testuose vietoj
// atsitiktinio teksto, nes routes/transcribe.js dabar tikrina TIKRĄ failo
// signature (utils/audioMagicBytes.js), ne tik plėtinį/mimetype.
function fakeMp3Buffer(extraContent = "papildomas testinis turinys po antraštės") {
  const id3Header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([id3Header, Buffer.from(extraContent)]);
}

// Minimalus WAV buferis (RIFF....WAVE antraštė).
function fakeWavBuffer(extraContent = "papildomas testinis turinys") {
  const header = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE")]);
  return Buffer.concat([header, Buffer.from(extraContent)]);
}

// Minimalus MP4/M4A konteinerio buferis (ftyp box antraštė) - naudojamas testuose,
// nes MP4 KONTEINERIS yra identiškas nepriklausomai nuo to, ar jame audio, ar
// audio+video (žr. routes/transcribe.js komentarą apie realų video.mp4 testą).
function fakeMp4Buffer(extraContent = "papildomas testinis turinys") {
  const header = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]), // box size
    Buffer.from("ftyp"),
    Buffer.from("isom"),
  ]);
  return Buffer.concat([header, Buffer.from(extraContent)]);
}

module.exports = { fakeMp3Buffer, fakeWavBuffer, fakeMp4Buffer };
