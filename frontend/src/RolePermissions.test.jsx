import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "./App.jsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonHeaders() {
  return { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) };
}

const OPERATOR = {
  username: "darbuotojas",
  role: "operator",
  permissions: ["job:create", "job:read", "protocol:generate", "export:redacted"],
};

const ADMIN = {
  username: "sysadmin",
  role: "administrator",
  permissions: [
    "job:create",
    "job:read",
    "job:delete",
    "protocol:generate",
    "export:redacted",
    "export:original",
    "audit:read",
  ],
};

/**
 * @param {object} opts
 * @param {object|null} opts.user - `null` = neprisijungęs
 * @param {Function} [opts.onExport] - kviečiama, kai bandoma eksportuoti
 * @param {number} [opts.exportStatus] - eksporto atsakymo statusas
 */
function mockBackend({ user, onExport, exportStatus = 200 }) {
  return vi.fn((url, options) => {
    const target = url.toString();

    if (target.includes("/api/auth/me")) {
      return Promise.resolve({
        ok: Boolean(user),
        status: user ? 200 : 401,
        headers: jsonHeaders(),
        json: () => Promise.resolve(user || { error: "Reikalingas prisijungimas.", code: "SESSION_REQUIRED" }),
      });
    }
    if (target.includes("/api/ready")) {
      return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve({ status: "ok" }) });
    }
    if (target.includes("/api/health")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: jsonHeaders(),
        json: () =>
          Promise.resolve({ status: "ok", llmProvider: "mock", transcriptionProvider: "mock", diarizationProvider: "none" }),
      });
    }
    if (target.includes("/api/exports")) {
      if (onExport) onExport(JSON.parse(options.body));

      if (exportStatus === 403) {
        return Promise.resolve({
          ok: false,
          status: 403,
          headers: jsonHeaders(),
          json: () =>
            Promise.resolve({
              error: "Neturite teisės atlikti šio veiksmo.",
              code: "PERMISSION_DENIED",
              requiredPermission: "export:original",
            }),
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (n) => (n.toLowerCase() === "content-type" ? "text/plain" : null) },
        blob: () => Promise.resolve(new Blob(["turinys"])),
      });
    }
    if (target.includes("/api/generate")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: jsonHeaders(),
        json: () => Promise.resolve({ protocol: { pavadinimas: "T" }, meta: {} }),
      });
    }

    return Promise.reject(new Error(`Netikėtas fetch URL teste: ${target}`));
  });
}

/**
 * Sugeneruoja protokolą, kad atsirastų eksporto skiltis.
 *
 * BE ŠITO eksporto testai būtų KLAIDINGAI TEIGIAMI: grupės nėra ne dėl
 * leidimų, o dėl to, kad protokolo dar nėra. Pirmoji šio failo versija taip ir
 * „praėjo" operatoriaus testą - patikrindama nieko.
 */
async function renderWithProtocol() {
  render(<App />);
  await screen.findByTestId("current-user");

  // Transkripcijos laukas rodomas TIK „Įklijuoti tekstą" režime.
  fireEvent.click(screen.getByText("Įklijuoti tekstą"));

  const textarea = screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/);
  fireEvent.change(textarea, {
    target: { value: "Jonas: Sveiki, pradedam susitikimą. Reikia parengti ataskaitą iki penktadienio." },
  });
  fireEvent.click(screen.getByRole("button", { name: /Generuoti protokolą/ }));

  // Eksporto skiltis atsiranda tik po sėkmingo generavimo.
  await screen.findByText(/Redaguotas \(jautrūs identifikatoriai pašalinti\)/i);
}

describe("#18 PR4: rolėmis grįsta sąsaja", () => {
  it("NEPRISIJUNGUS rodoma prisijungimo forma, ne pagrindinis UI", async () => {
    global.fetch = mockBackend({ user: null });

    render(<App />);

    expect(await screen.findByLabelText("Vartotojo vardas")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generuoti/i })).not.toBeInTheDocument();
  });

  it("PRISIJUNGUS rodomas vartotojas ir jo rolė", async () => {
    global.fetch = mockBackend({ user: OPERATOR });

    render(<App />);

    const badge = await screen.findByTestId("current-user");
    expect(badge).toHaveTextContent("darbuotojas");
    expect(badge).toHaveTextContent("operatorius");
  });

  it("OPERATORIUS nemato originalo eksporto grupės", async () => {
    global.fetch = mockBackend({ user: OPERATOR });

    await renderWithProtocol();

    /**
     * Grupė SLEPIAMA, o ne rodoma išjungta: išjungtas mygtukas be paaiškinimo
     * atrodo kaip gedimas, o rolė juostoje paaiškina, kodėl jo nėra.
     *
     * Redaguoto eksporto grupė TURI likti - kitaip testas praeitų ir tada, jei
     * dingtų visa eksporto skiltis.
     */
    expect(screen.getByText(/Redaguotas \(jautrūs identifikatoriai pašalinti\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/Originalas \(visi duomenys\)/i)).not.toBeInTheDocument();
  });

  it("ADMINISTRATORIUS mato originalo eksporto grupę", async () => {
    global.fetch = mockBackend({ user: ADMIN });

    await renderWithProtocol();

    expect(screen.getByText(/Originalas \(visi duomenys\)/i)).toBeInTheDocument();
  });

  it("UI NĖRA APSAUGA: net apėjus sąsają, backend 403 parodomas vartotojui", async () => {
    /**
     * SVARBIAUSIAS ŠIO FAILO TESTAS.
     *
     * Imituojam situaciją, kai klientas kažkaip pasiekia eksportą, kurio
     * neturėtų (pakeistas JS, senas skirtukas, tiesioginis kvietimas). Backend
     * grąžina 403, ir UI privalo tai parodyti kaip TEISIŲ problemą, o ne kaip
     * eksporto gedimą – kitaip vartotojas bandytų vėl ir vėl.
     *
     * Frontend leidimai valdo tik atvaizdavimą; tikroji riba yra serveryje.
     */
    global.fetch = mockBackend({ user: ADMIN, exportStatus: 403 });

    // Originalo eksportas reikalauja patvirtinimo (GDPR #8); jsdom `confirm`
    // neturi, tad be mock'o eksportas būtų tyliai atšauktas.
    window.confirm = vi.fn(() => true);

    await renderWithProtocol();

    const originalButtons = await screen.findAllByRole("button", { name: /\.txt/i });
    fireEvent.click(originalButtons[originalButtons.length - 1]);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/neturite teisės/i);
    expect(alert).toHaveTextContent(/export:original/);
  });

  it("SESIJOS PABAIGA grąžina į prisijungimą su paaiškinimu, ne su bendra klaida", async () => {
    /**
     * 401 ≠ 403. Sesijai pasibaigus vartotojas turi pamatyti „prisijunkite iš
     * naujo", o ne „neturite teisės" – priešingu atveju jis manytų, kad
     * prarado teises, nors tereikia prisijungti.
     */
    let meCallCount = 0;

    global.fetch = vi.fn((url) => {
      const target = url.toString();

      if (target.includes("/api/auth/me")) {
        meCallCount += 1;
        return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve(ADMIN) });
      }
      if (target.includes("/api/ready")) {
        return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve({ status: "ok" }) });
      }
      if (target.includes("/api/health")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: jsonHeaders(),
          json: () => Promise.resolve({ status: "ok", llmProvider: "mock" }),
        });
      }
      if (target.includes("/api/generate")) {
        // Sesija pasibaigė BŪTENT veiksmo metu.
        return Promise.resolve({
          ok: false,
          status: 401,
          headers: jsonHeaders(),
          json: () => Promise.resolve({ error: "Reikalingas prisijungimas.", code: "SESSION_REQUIRED" }),
        });
      }
      return Promise.reject(new Error(`Netikėtas URL: ${target}`));
    });

    render(<App />);
    await screen.findByTestId("current-user");

    fireEvent.click(screen.getByText("Įklijuoti tekstą"));

    const textarea = screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/);
    fireEvent.change(textarea, {
      target: { value: "Jonas: Sveiki, pradedam susitikimą. Reikia parengti ataskaitą iki penktadienio." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Generuoti protokolą/ }));

    await waitFor(() => {
      expect(screen.getByText(/Sesija pasibaigė/)).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Vartotojo vardas")).toBeInTheDocument();
    expect(meCallCount).toBeGreaterThan(0);
  });

  it("LEIDIMAI ateina IŠ BACKEND'O, o ne skaičiuojami pagal rolės pavadinimą", async () => {
    /**
     * Netipinis derinys: rolė sako `operator`, bet backend davė
     * `export:original`. UI privalo paklusti LEIDIMŲ sąrašui, ne rolės
     * pavadinimui – kitaip rolių žemėlapis egzistuotų dviejose vietose ir
     * ilgainiui išsiskirtų.
     */
    const netipinis = { ...OPERATOR, permissions: [...OPERATOR.permissions, "export:original"] };
    global.fetch = mockBackend({ user: netipinis });

    await renderWithProtocol();

    expect(screen.getByText(/Originalas \(visi duomenys\)/i)).toBeInTheDocument();
  });

  it("ATSIJUNGIMAS: nepavykusi revokacija NEPERJUNGIA į anoniminę būseną", async () => {
    /**
     * ⚠️ REGRESIJA, KURIĄ ŠIS TESTAS UŽDARO (#155, 7.3).
     *
     * Po 7.3 serveris grąžina `503 SESSION_STORE_UNAVAILABLE`, kai sesijos
     * revokuoti nepavyksta, ir SĄMONINGAI NEIŠVALO cookie – ji tebegalioja.
     * `logout()` ignoravo `res.ok`, o `handleLogout` turėjo `.catch(() => {})`
     * ir vis tiek nustatydavo anoniminę būseną: vartotojui parodoma
     * „atsijungta", o bearer token'as lieka naršyklėje ir vėl ima veikti DB
     * atsistačius.
     *
     * Tikrinama, kad UI LIEKA prisijungęs ir parodo klaidą – ne kad kvietimas
     * įvyko.
     */
    global.fetch = vi.fn((url) => {
      const target = url.toString();
      if (target.includes("/api/auth/logout")) {
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: jsonHeaders(),
          json: () =>
            Promise.resolve({
              error: "Sesijų saugykla nepasiekiama.",
              code: "SESSION_STORE_UNAVAILABLE",
            }),
        });
      }
      if (target.includes("/api/auth/me")) {
        return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve(ADMIN) });
      }
      if (target.includes("/api/ready")) {
        return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve({ status: "ok" }) });
      }
      if (target.includes("/api/health")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: jsonHeaders(),
          json: () => Promise.resolve({ status: "ok", llmProvider: "mock" }),
        });
      }
      return Promise.reject(new Error(`Netikėtas URL: ${target}`));
    });

    render(<App />);
    await screen.findByTestId("current-user");

    fireEvent.click(screen.getByRole("button", { name: /atsijungti/i }));

    await waitFor(() => {
      expect(screen.getByText(/Sesija TEBEGALIOJA/i)).toBeInTheDocument();
    });

    /** Prisijungimo forma NEATSIRADO - vartotojas tebėra autentifikuotas. */
    expect(screen.queryByLabelText("Vartotojo vardas")).not.toBeInTheDocument();
    expect(screen.getByTestId("current-user")).toBeInTheDocument();
  });

  it("ATSIJUNGIMAS grąžina į prisijungimo formą", async () => {
    global.fetch = vi.fn((url) => {
      const target = url.toString();
      if (target.includes("/api/auth/logout")) {
        return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve({ ok: true }) });
      }
      if (target.includes("/api/auth/me")) {
        return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve(ADMIN) });
      }
      if (target.includes("/api/ready")) {
        return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve({ status: "ok" }) });
      }
      if (target.includes("/api/health")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: jsonHeaders(),
          json: () => Promise.resolve({ status: "ok", llmProvider: "mock" }),
        });
      }
      return Promise.reject(new Error(`Netikėtas URL: ${target}`));
    });

    render(<App />);
    await screen.findByTestId("current-user");

    fireEvent.click(screen.getByRole("button", { name: /atsijungti/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Vartotojo vardas")).toBeInTheDocument();
    });

    // Atsijungus NEturi būti „sesija pasibaigė" - vartotojas pats išėjo.
    expect(screen.queryByText(/sesija pasibaigė/i)).not.toBeInTheDocument();
  });
});

describe("#18 PR4: dev režimas be sukonfigūruotos autentifikacijos", () => {
  it("rodo PAGRINDINĮ UI, ne prisijungimo formą", async () => {
    /**
     * BŪTENT ŠIS ELGESYS SULAUŽĖ E2E.
     *
     * Backend dev režime (be `AUTH_USERS` ir `API_KEY`) praleidžia visas
     * užklausas, tad `/auth/me` grąžina dev tapatybę. Frontend privalo ją
     * priimti kaip bet kurią kitą – priešingu atveju vartotojas matytų
     * prisijungimo formą sistemai, kuri leidžia viską, ir prisijungti nebūtų
     * kaip: vartotojų juk nesukonfigūruota.
     *
     * E2E testai to nepasakė aiškiai – jie tiesiog kabojo timeout'uose.
     */
    const devUser = {
      username: "dev",
      role: "administrator",
      permissions: ["job:create", "job:read", "job:delete", "protocol:generate", "export:redacted", "export:original", "audit:read"],
      authConfigured: false,
    };

    global.fetch = mockBackend({ user: devUser });

    render(<App />);

    // Pagrindinis UI, ne prisijungimo forma.
    expect(await screen.findByTestId("current-user")).toBeInTheDocument();
    expect(screen.queryByLabelText("Vartotojo vardas")).not.toBeInTheDocument();
  });
});
