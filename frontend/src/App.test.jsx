import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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

function jsonHeaders() {
  return { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) };
}

function mockFetchImplementation({ healthResponse, generateResponse, generateStatus = 200, readyStatus = 200 }) {
  return vi.fn((url, options) => {
    // /api/ready TIKRINAM PIRMA (nes "/api/health" substring irgi tiktų kai kuriems).
    if (url.toString().includes("/api/ready")) {
      return Promise.resolve({
        ok: readyStatus < 400,
        status: readyStatus,
        headers: jsonHeaders(),
        json: () => Promise.resolve({ ready: readyStatus < 400, components: { jobStore: true, jobRunner: true } }),
      });
    }
    if (url.toString().includes("/api/health")) {
      return Promise.resolve({
        ok: true,
        headers: jsonHeaders(),
        json: () => Promise.resolve(healthResponse),
      });
    }
    if (url.toString().includes("/api/generate")) {
      return Promise.resolve({
        ok: generateStatus < 400,
        status: generateStatus,
        headers: jsonHeaders(),
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

describe("App - eksportas per backend (GDPR audito reikalavimas)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createdLinks = [];

  const fakeProtocol = {
    pavadinimas: "Eksporto testas",
    data: "2026-07-30",
    dalyviai: ["Jonas"],
    darbotvarke: ["Punktas"],
    aptarti_klausimai: [{ klausimas: "K", santrauka: "S" }],
    nutarimai: ["N"],
    veiksmai: [{ uzduotis: "U", atsakingas: "Jonas", terminas: "rytoj" }],
  };

  async function renderWithProtocol(exportHandler) {
    const base = mockFetchImplementation({
      healthResponse: { status: "ok", llmProvider: "mock", transcriptionProvider: "mock", diarizationProvider: "none" },
      generateResponse: {
        protocol: fakeProtocol,
        meta: { promptVersion: "meeting_v2", llmProvider: "mock", jsonRepairAttempts: 0, processingTimeMs: 5 },
      },
    });

    global.fetch = vi.fn((url, options) => {
      if (url.toString().includes("/api/exports")) return exportHandler(url, options);
      return base(url, options);
    });

    // URL.createObjectURL neegzistuoja jsdom'e.
    global.URL.createObjectURL = vi.fn(() => "blob:mock");
    global.URL.revokeObjectURL = vi.fn();

    // Perimam sukurtas <a> nuorodas, kad galėtume patikrinti download failo vardą.
    createdLinks.length = 0;
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag, ...rest) => {
      const element = realCreateElement(tag, ...rest);
      if (String(tag).toLowerCase() === "a") createdLinks.push(element);
      return element;
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Backend aktyvus/)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Įklijuoti tekstą"));
    fireEvent.change(screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/), {
      target: { value: "Jonas: Sveiki, pradedam susitikimą. Reikia parengti pasiūlymą iki penktadienio." },
    });
    fireEvent.click(screen.getByText("Generuoti protokolą"));
    await waitFor(() => expect(screen.getByDisplayValue("Eksporto testas")).toBeInTheDocument());

    return global.fetch;
  }

  it("eksportuoja per POST /api/exports, o ne generuoja failą naršyklėje", async () => {
    // Tai NE kosmetika: kol failas kuriamas naršyklėje, serveris apie eksportą
    // nežino ir EXPORT_* audito įrašo būti negali.
    const fetchMock = await renderWithProtocol(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: (name) =>
            name.toLowerCase() === "content-disposition"
              ? 'attachment; filename="protokolas_2026-07-30.docx"'
              : null,
        },
        blob: () => Promise.resolve(new Blob(["PK"])),
      })
    );

    // Mygtuko pavadinimą tikrinam PER ROLE ir TIKSLIAI tokį, kokio ieško Playwright
    // E2E (`getByRole("button", { name: "Word (.docx)" })`). Eksporto mygtukų tekstas
    // dabar dinamiškas ("Ruošiama…"), tad be šito E2E galėtų nutrūkti, o jo šioje
    // aplinkoje paleisti negalima (Chromium atsisiuntimas blokuojamas).
    /**
     * Mygtukų dabar yra PO DU (redaguotas ir originalas), tad vardo nebeužtenka -
     * reikia grupės (GDPR #8). Grupės pavadinimas yra ta pati informacija, kurią
     * mato vartotojas, todėl selektorius lieka prasmingas, o ne techninis.
     */
    const redactedGroup = screen.getByRole("group", { name: /Redaguotas/ });
    const docxButton = within(redactedGroup).getByRole("button", { name: "Word (.docx)" });
    const txtButton = within(redactedGroup).getByRole("button", { name: ".txt" });
    const csvButton = within(redactedGroup).getByRole("button", { name: "Veiksmai .csv" });
    expect(docxButton).toBeInTheDocument();
    expect(txtButton).toBeInTheDocument();
    expect(csvButton).toBeInTheDocument();

    fireEvent.click(docxButton);

    await waitFor(() => {
      const exportCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/exports"));
      expect(exportCall).toBeTruthy();
      expect(exportCall[1].method).toBe("POST");
      expect(JSON.parse(exportCall[1].body).format).toBe("docx");
    });

    // E2E tikrina download.suggestedFilename() -> /\.docx$/. Naršyklėje tai yra
    // <a download> atributas, tad tikrinam jį.
    await waitFor(() => {
      expect(createdLinks.some((a) => /\.docx$/.test(a.download))).toBe(true);
    });
  });

  it("parodo klaidą, kai backend eksportas nepavyksta (be tylaus lokalaus fallback)", async () => {
    await renderWithProtocol(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve({ error: "Eksporto servisas nepasiekiamas." }),
      })
    );

    fireEvent.click(
      within(screen.getByRole("group", { name: /Redaguotas/ })).getByRole("button", { name: ".txt" })
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Eksporto servisas nepasiekiamas.");
    });
  });
});
