import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import App from "./App.jsx";

/**
 * Šis testų failas papildo src/utils.test.js (kuris testuoja tik gryna funkcijas) -
 * čia testuojama TIKRA komponento elgsena: backend health statuso indikatorius,
 * formos pildymas ir generavimo srautas su MOCKED fetch (be tikro backend'o).
 *
 * Apima tik dalį App.jsx elgsenos - žr. backend/README.md ir README.md Roadmap
 * dėl to, kas dar NETESTUOTA (audio upload srautas, protokolo redagavimas,
 * eksportai, diarizacijos pasirinkimas ir pan.).
 */

function mockFetchImplementation({ healthResponse, generateResponse, generateStatus = 200 }) {
  return vi.fn((url, options) => {
    if (url.toString().includes("/api/health")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(healthResponse),
      });
    }
    if (url.toString().includes("/api/generate")) {
      return Promise.resolve({
        ok: generateStatus < 400,
        status: generateStatus,
        json: () => Promise.resolve(generateResponse),
      });
    }
    return Promise.reject(new Error(`Netikėtas fetch URL teste: ${url}`));
  });
}

describe("App - backend health statusas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rodo "Backend aktyvus" su tiekėjų info, kai /api/health atsako sėkmingai', async () => {
    global.fetch = mockFetchImplementation({
      healthResponse: { status: "ok", llmProvider: "mock", transcriptionProvider: "mock", diarizationProvider: "none" },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Backend aktyvus/)).toBeInTheDocument();
    });
    expect(screen.getByText(/mock \/ mock \/ diarizacija: none/)).toBeInTheDocument();
  });

  it('rodo "Backend nepasiekiamas" ir įspėjimą, kai /api/health kvietimas nepavyksta', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("network error")));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Backend nepasiekiamas/)).toBeInTheDocument();
    });
    expect(screen.getByText(/npm install && npm start/)).toBeInTheDocument();
  });
});

describe("App - generavimo srautas (mocked /api/generate)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leidžia įklijuoti tekstą, generuoti protokolą ir parodo rezultatą redaguojamuose laukuose", async () => {
    const fakeProtocol = {
      pavadinimas: "Testinis susitikimas",
      data: "2026-07-14",
      dalyviai: ["Jonas"],
      darbotvarke: ["Biudžeto aptarimas"],
      aptarti_klausimai: [{ klausimas: "Biudžetas", santrauka: "Aptartas padidinimas." }],
      nutarimai: ["Padidinti biudžetą"],
      veiksmai: [{ uzduotis: "Parengti pasiūlymą", atsakingas: "Jonas", terminas: "penktadienis" }],
    };

    global.fetch = mockFetchImplementation({
      healthResponse: { status: "ok", llmProvider: "mock", transcriptionProvider: "mock", diarizationProvider: "none" },
      generateResponse: {
        protocol: fakeProtocol,
        meta: { promptVersion: "meeting_v2", llmProvider: "mock", jsonRepairAttempts: 0, processingTimeMs: 12 },
      },
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/Backend aktyvus/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Įklijuoti tekstą"));

    const textarea = screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/);
    fireEvent.change(textarea, {
      target: { value: "Jonas: Sveiki, pradedam susitikimą. Reikia parengti pasiūlymą iki penktadienio." },
    });

    const generateButton = screen.getByText("Generuoti protokolą");
    expect(generateButton.closest("button")).not.toBeDisabled();
    fireEvent.click(generateButton);

    await waitFor(() => {
      expect(screen.getByDisplayValue("Testinis susitikimas")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue(/Parengti pasiūlymą/)).toBeInTheDocument();
  });

  it("generavimo mygtukas išjungtas, kai backend nepasiekiamas, net jei tekstas įvestas", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("network error")));

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Backend nepasiekiamas/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Įklijuoti tekstą"));
    const textarea = screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/);
    fireEvent.change(textarea, { target: { value: "Pakankamai ilgas tekstas, kad praeitų validaciją." } });

    const generateButton = screen.getByText("Generuoti protokolą").closest("button");
    expect(generateButton).toBeDisabled();
  });

  it("rodo klaidos pranešimą, kai backend grąžina klaidą generuojant", async () => {
    global.fetch = mockFetchImplementation({
      healthResponse: { status: "ok", llmProvider: "mock", transcriptionProvider: "mock", diarizationProvider: "none" },
      generateResponse: { error: "Vidinė serverio klaida apdorojant užklausą. Pabandykite vėliau." },
      generateStatus: 500,
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Backend aktyvus/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Įklijuoti tekstą"));
    const textarea = screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/);
    fireEvent.change(textarea, { target: { value: "Pakankamai ilgas tekstas, kad praeitų validaciją." } });
    fireEvent.click(screen.getByText("Generuoti protokolą"));

    await waitFor(() => {
      expect(screen.getByText(/Nepavyko sugeneruoti protokolo/)).toBeInTheDocument();
    });
  });
});
