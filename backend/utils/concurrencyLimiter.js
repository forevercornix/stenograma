/**
 * Lokalus (embedded) transkribavimas per Python subprocess yra CPU/RAM sunkus -
 * be jokio limito, 5 vienalaikiai vartotojai galėtų paleisti 5 modelio kopijas
 * vienu metu ir prisotinti (saturate) CPU/RAM host'e. Šis semaforas riboja, kiek
 * subprocess'ų gali vykti VIENU METU - likusios užklausos LAUKIA eilėje (ne
 * atmetamos iš karto), kol atsilaisvins vieta.
 *
 * SĄŽININGAS APRIBOJIMAS: tai paprastas in-process semaforas, ne tikras worker
 * pool su prioritetais/timeout'ais eilėje ar paskirstymu tarp kelių serverio
 * procesų/mašinų. Jei reikia sudėtingesnio resursų valdymo (pvz. GPU memory
 * limitai, prioritetinės eilės), verta pereiti prie tikros queue sistemos
 * (žr. backend/README.md "Job queue" skyrių dėl analogiškos rekomendacijos).
 */
class Semaphore {
  constructor(maxConcurrent) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.current = 0;
    this.queue = [];
  }

  acquire() {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }

  get queueLength() {
    return this.queue.length;
  }
}

module.exports = { Semaphore };
