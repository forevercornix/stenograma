const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");

/**
 * TIKROS failų sistemos testai (be stub'ų).
 *
 * Kiti testai `fileStorage` pakeičia mock'u, tad jie NEPATIKRINA būtent to, kas
 * lemia GDPR garantiją: ar `del()` skiria "failo nebėra" nuo "ištrinti nepavyko".
 * Anksčiau `del()` darė `.catch(() => {})` ir prarydavo VISAS klaidas.
 */

let storageDir;
let fileStorage;

test.before(async () => {
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "stenograma-storage-"));
  process.env.STORAGE_DIR = storageDir;

  delete require.cache[require.resolve("../utils/fileStorage")];
  fileStorage = require("../utils/fileStorage");
});

test.after(async () => {
  await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.STORAGE_DIR;
});

test("put + get + del: pilnas gyvavimo ciklas", async () => {
  const key = await fileStorage.put(Buffer.from("audio-turinys"), { ext: ".wav" });

  assert.match(key, /^uploads\//);
  assert.equal((await fileStorage.get(key)).toString(), "audio-turinys");

  assert.equal(await fileStorage.del(key), true, "esamas failas -> true");
  await assert.rejects(() => fileStorage.get(key));
});

test("del: nesamas failas laikomas sėkme (false, be klaidos)", async () => {
  assert.equal(await fileStorage.del("uploads/nera-tokio.wav"), false);
});

test("del: NE ENOENT klaida perduodama aukštyn (EACCES)", async () => {
  // Tai tiksliai tas atvejis, dėl kurio storageKey nebūdavo išsaugotas: anksčiau
  // ši klaida būdavo nutylima ir raktas dingdavo, o failas likdavo diske.
  if (process.getuid && process.getuid() === 0) {
    // root apeina failų teises - patikra beprasmė.
    return;
  }

  const key = await fileStorage.put(Buffer.from("apsaugotas"), { ext: ".wav" });
  const dir = path.dirname(path.join(storageDir, key));

  await fs.chmod(dir, 0o500); // r-x: skaityti galima, trinti - ne

  try {
    await assert.rejects(
      () => fileStorage.del(key),
      (error) => error.code === "EACCES" || error.code === "EPERM"
    );
  } finally {
    await fs.chmod(dir, 0o700);
    await fileStorage.del(key).catch(() => {});
  }
});

test("path traversal neišveda už storage katalogo", () => {
  // PASTABA: implementacija traversal ne meta, o NUKERPA (`../` prefiksai
  // pašalinami), tad tikrinam tikrąją saugumo savybę - rezultatas visada lieka
  // storage ribose - o ne konkretų klaidos pranešimą.
  const root = path.resolve(storageDir);

  for (const key of [
    "../../etc/passwd",
    "uploads/../../../etc/passwd",
    "..\\..\\windows\\system32",
    "/etc/passwd",
  ]) {
    let resolved;
    try {
      resolved = fileStorage._resolve(key);
    } catch (error) {
      assert.match(error.message, /path traversal/); // absoliutūs keliai atmetami
      continue;
    }

    assert.ok(
      resolved === root || resolved.startsWith(root + path.sep),
      `${key} -> ${resolved} išėjo už storage ribų`
    );
  }
});

test("kaimyninis katalogas su tuo pačiu prefiksu neapgauna patikros", () => {
  // `startsWith` be skyriklio praleisdavo "/storage-evil" kaip "/storage" vidų.
  const resolved = fileStorage._resolve("uploads/failas.wav");
  assert.ok(resolved.startsWith(path.resolve(storageDir) + path.sep));
});

test("simbolinė nuoroda už storage katalogo ribų atmetama", async () => {
  // `_resolve()` tikrina tik TEKSTINĮ kelią. Jei storage kataloge atsirastų
  // symlink į išorę, be realpath patikros būtų ištrintas svetimas failas.
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "stenograma-outside-"));
  const victim = path.join(outside, "svarbus.txt");
  await fs.writeFile(victim, "neliesti");

  const linkKey = "uploads/nuoroda.wav";
  const linkPath = path.join(storageDir, linkKey);
  await fs.mkdir(path.dirname(linkPath), { recursive: true });

  try {
    await fs.symlink(victim, linkPath);
  } catch {
    await fs.rm(outside, { recursive: true, force: true });
    return; // aplinka neleidžia symlink'ų - testas netaikomas
  }

  try {
    await assert.rejects(() => fileStorage.del(linkKey), /symlink/);
    assert.equal(
      (await fs.readFile(victim)).toString(),
      "neliesti",
      "failas už storage ribų turi likti nepaliestas"
    );
  } finally {
    await fs.unlink(linkPath).catch(() => {});
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  }
});

test("releaseAudio su TIKRU storage: nepavykus trynimui storageKey lieka", async () => {
  if (process.getuid && process.getuid() === 0) return;

  const jobStore = require("../utils/jobStore");
  const { releaseAudio } = require("../utils/audioCleanup");

  const key = await fileStorage.put(Buffer.from("audio"), { ext: ".wav" });
  const job = await jobStore.create({ ownerKind: "unowned", type: jobStore.JOB_TYPES.TRANSCRIPTION, storageKey: key });

  const dir = path.dirname(path.join(storageDir, key));
  await fs.chmod(dir, 0o500);

  try {
    assert.equal(await releaseAudio(job.id, key), false);

    const after = await jobStore.system.get(job.id);
    assert.equal(after.storageKey, key, "raktas turi likti, kad ištrynimą būtų galima pakartoti");
  } finally {
    await fs.chmod(dir, 0o700);
    await fileStorage.del(key).catch(() => {});
    await jobStore.system.remove(job.id);
  }
});
