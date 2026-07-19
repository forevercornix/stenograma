const test = require("node:test");
const assert = require("node:assert/strict");
const { Semaphore } = require("../utils/concurrencyLimiter");

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("Semaphore: leidžia iki maxConcurrent vienalaikių acquire() be laukimo", async () => {
  const sem = new Semaphore(2);
  const start = Date.now();
  await sem.acquire();
  await sem.acquire();
  assert.ok(Date.now() - start < 50); // abu iškart, be laukimo
  assert.equal(sem.queueLength, 0);
});

test("Semaphore: trečias acquire() laukia, kol vienas release()", async () => {
  const sem = new Semaphore(1);
  await sem.acquire(); // slot #1 užimtas

  let secondAcquired = false;
  const secondAcquire = sem.acquire().then(() => {
    secondAcquired = true;
  });

  await wait(30);
  assert.equal(secondAcquired, false); // dar laukia, nes slot užimtas
  assert.equal(sem.queueLength, 1);

  sem.release(); // atlaisviname #1
  await secondAcquire;
  assert.equal(secondAcquired, true);
});

test("Semaphore: release() be jokio laukiančio tiesiog sumažina skaitliuką", async () => {
  const sem = new Semaphore(3);
  await sem.acquire();
  await sem.acquire();
  sem.release();
  assert.equal(sem.queueLength, 0);
  // vietos vėl yra - trečias acquire turėtų būti iškart
  const start = Date.now();
  await sem.acquire();
  assert.ok(Date.now() - start < 50);
});

test("Semaphore: minimali riba yra 1 (Math.max apsauga nuo 0/neigiamos konfigūracijos)", () => {
  const sem = new Semaphore(0);
  assert.equal(sem.maxConcurrent, 1);
});
