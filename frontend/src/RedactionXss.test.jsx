import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import App from "./App.jsx";

/**
 * GDPR #4 DoD: „Frontend tests confirm that HTML/XSS payloads in transcript text
 * or placeholders are rendered as text, not executable DOM."
 *
 * Kodėl to reikia, nors React ir escape'ina pagal nutylėjimą: transkripcija yra
 * NEPATIKIMAS įvestis - ją sudaro tai, ką pasakė žmonės, arba tai, ką grąžino
 * išorinis transkribavimo tiekėjas. Redakcijos placeholder'iai (`[ASMENS_KODAS]`)
 * atrodo kaip žymėjimas, tad kyla pagunda kada nors juos „gražiai atvaizduoti"
 * per `dangerouslySetInnerHTML`. Šie testai tokį pakeitimą sulaužytų iškart.
 */

const XSS = '<img src=x onerror="window.__xssFired = true">';
const SCRIPT = "<script>window.__xssFired = true;</script>";

function jsonHeaders() {
  return { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) };
}

/** Prisijungęs administratorius - visi leidimai (#18 PR4). */
const TEST_ADMIN = {
  username: "testuotojas",
  role: "administrator",
  permissions: ["job:create", "job:read", "job:delete", "protocol:generate", "export:redacted", "export:original", "audit:read"],
};

function mockFetch({ generateResponse }) {
  return vi.fn((url) => {
    // Sesija (#18 PR4) - be jos programa rodytų prisijungimo formą.
    if (url.toString().includes("/api/auth/me")) {
      return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve(TEST_ADMIN) });
    }
    if (url.toString().includes("/api/ready")) {
      return Promise.resolve({ ok: true, status: 200, headers: jsonHeaders(), json: () => Promise.resolve({ status: "ok" }) });
    }
    if (url.toString().includes("/api/health")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: jsonHeaders(),
        json: () =>
          Promise.resolve({
            status: "ok",
            llmProvider: "mock",
            transcriptionProvider: "mock",
            diarizationProvider: "none",
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: jsonHeaders(),
      json: () => Promise.resolve(generateResponse),
    });
  });
}

describe("XSS: redaguota transkripcija ir placeholder'iai atvaizduojami kaip TEKSTAS", () => {
  afterEach(() => {
    delete window.__xssFired;
    vi.restoreAllMocks();
  });

  it("HTML transkripcijos lauke nevykdomas ir netampa DOM elementu", async () => {
    global.fetch = mockFetch({ generateResponse: { protocol: {}, meta: {} } });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Backend aktyvus/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Įklijuoti tekstą"));
    const textarea = screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/);
    fireEvent.change(textarea, { target: { value: `${XSS} ${SCRIPT} [ASMENS_KODAS]` } });

    expect(window.__xssFired).toBeUndefined();
    expect(document.querySelector("img[onerror]")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    // Turinys IŠLIEKA - jis rodomas, tik kaip tekstas.
    expect(textarea.value).toContain("[ASMENS_KODAS]");
  });

  it("protokolo laukai su HTML iš backend'o lieka tekstu", async () => {
    const hostileProtocol = {
      pavadinimas: `Posėdis ${XSS}`,
      data: "2026-01-01",
      dalyviai: [`Jonas ${SCRIPT}`],
      darbotvarke: ["[ASMENS_KODAS] aptarimas"],
      aptarti_klausimai: [{ klausimas: XSS, santrauka: "[EL_PAŠTAS]" }],
      nutarimai: [`Susisiekti [TELEFONAS] ${XSS}`],
      veiksmai: [{ uzduotis: SCRIPT, atsakingas: "[ASMUO]", terminas: "2026-02-01" }],
    };

    global.fetch = mockFetch({
      generateResponse: {
        protocol: hostileProtocol,
        meta: { promptVersion: "meeting_v3", llmProvider: "mock", jsonRepairAttempts: 0, processingTimeMs: 5 },
        redaction: { variant: "redacted", policyVersion: "pii-v1", redactionStats: { PERSONAL_CODE: 1 } },
      },
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Backend aktyvus/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Įklijuoti tekstą"));
    fireEvent.change(screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/), {
      target: { value: "Jonas: Sveiki, pradedam. Reikia parengti pasiūlymą iki penktadienio." },
    });
    fireEvent.click(screen.getByText("Generuoti protokolą"));

    await waitFor(() => expect(screen.getByDisplayValue(`Posėdis ${XSS}`)).toBeInTheDocument());

    // Esmė: payload'as ATĖJO iki DOM, bet kaip reikšmė, ne kaip žymėjimas.
    expect(window.__xssFired).toBeUndefined();
    expect(document.querySelector("img[onerror]")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });

  it("placeholder'iai atvaizduojami pažodžiui, be interpretavimo", async () => {
    const protocol = {
      pavadinimas: "Posėdis",
      data: "2026-01-01",
      dalyviai: ["[ASMENS_KODAS]"],
      darbotvarke: ["<b>[EL_PAŠTAS]</b>"],
      aptarti_klausimai: [],
      nutarimai: [],
      veiksmai: [],
    };

    global.fetch = mockFetch({ generateResponse: { protocol, meta: {} } });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Backend aktyvus/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Įklijuoti tekstą"));
    fireEvent.change(screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/), {
      target: { value: "Jonas: Sveiki, pradedam susitikimą ir aptariam biudžetą." },
    });
    fireEvent.click(screen.getByText("Generuoti protokolą"));

    await waitFor(() => expect(screen.getByDisplayValue("[ASMENS_KODAS]")).toBeInTheDocument());

    // `<b>` turi likti matomas kaip tekstas, o ne paversti tekstą paryškintu.
    expect(screen.getByDisplayValue("<b>[EL_PAŠTAS]</b>")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });
});
