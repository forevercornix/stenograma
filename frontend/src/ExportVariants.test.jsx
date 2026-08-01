import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import App from "./App.jsx";

/**
 * GDPR #8 (frontend): VARIANTŲ PASIRINKIMAS.
 *
 * Trys atskiri reikalavimai, kuriuos lengva supainioti:
 *  1. abu variantai matomi ir aiškiai įvardyti;
 *  2. numatytasis kelias yra REDAGUOTAS - t. y. paspaudus nesusimąstant
 *     gaunamas saugesnis variantas;
 *  3. originalas reikalauja ATSKIRO veiksmo IR patvirtinimo.
 *
 * Trečiasis svarbiausias: originalą dažniausiai pasirenka netyčia, o klaida
 * pastebima tik tada, kai failas jau išsiųstas.
 */

const PROTOCOL = {
  pavadinimas: "Posėdis",
  data: "2026-03-15",
  dalyviai: ["Jonas"],
  darbotvarke: ["Ataskaita"],
  aptarti_klausimai: [],
  nutarimai: [],
  veiksmai: [],
};

function jsonHeaders(extra = {}) {
  const headers = { "content-type": "application/json", ...extra };
  return { get: (name) => headers[name.toLowerCase()] ?? null };
}

function mockBackend({ onExport } = {}) {
  return vi.fn((url, options) => {
    const target = url.toString();

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
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: jsonHeaders({ "content-disposition": 'attachment; filename="protokolas_redaguotas_2026-03-15.txt"' }),
        blob: () => Promise.resolve(new Blob(["turinys"])),
      });
    }

    return Promise.resolve({
      ok: true,
      status: 200,
      headers: jsonHeaders(),
      json: () => Promise.resolve({ protocol: PROTOCOL, meta: {} }),
    });
  });
}

async function renderWithProtocol(fetchMock) {
  global.fetch = fetchMock;
  global.URL.createObjectURL = vi.fn(() => "blob:test");
  global.URL.revokeObjectURL = vi.fn();

  render(<App />);
  await waitFor(() => expect(screen.getByText(/Backend aktyvus/)).toBeInTheDocument());

  fireEvent.click(screen.getByText("Įklijuoti tekstą"));
  fireEvent.change(screen.getByPlaceholderText(/Įklijuokite susitikimo transkripciją/), {
    target: { value: "Jonas: Sveiki, pradedam posėdį ir aptariam ketvirčio rezultatus." },
  });
  fireEvent.click(screen.getByText("Generuoti protokolą"));

  await waitFor(() => expect(screen.getByRole("group", { name: /Redaguotas/ })).toBeInTheDocument());
}

describe("#8 frontend: eksporto variantai", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.confirm;
  });

  it("ABU variantai matomi ir aiškiai įvardyti", async () => {
    await renderWithProtocol(mockBackend());

    const redacted = screen.getByRole("group", { name: /Redaguotas/ });
    const original = screen.getByRole("group", { name: /Originalas/ });

    // Etiketės turi pasakyti, KUO variantai skiriasi, o ne tik kaip vadinasi.
    /**
     * Etiketė NEGALI žadėti „be asmens duomenų": pagal #4 aprėptį vardai lieka,
     * adresai neaptinkami. Toks pažadas paskatintų persiųsti dokumentą kaip
     * anoniminį - tai privatumo defektas, ne teksto niuansas.
     */
    expect(screen.getByText(/Redaguotas \(jautrūs identifikatoriai pašalinti\)/)).toBeInTheDocument();
    expect(screen.getByText(/Vardai, adresai ir kiti netiesioginiai identifikatoriai gali likti/)).toBeInTheDocument();
    expect(screen.getByText(/Originalas \(visi duomenys\)/)).toBeInTheDocument();

    // Klaidinantis pažadas neturi grįžti.
    expect(screen.queryByText(/be asmens duomenų/)).toBeNull();

    // Abu variantai palaiko tuos pačius formatus.
    for (const group of [redacted, original]) {
      expect(within(group).getByRole("button", { name: ".txt" })).toBeInTheDocument();
      expect(within(group).getByRole("button", { name: "Word (.docx)" })).toBeInTheDocument();
      expect(within(group).getByRole("button", { name: "Veiksmai .csv" })).toBeInTheDocument();
    }
  });

  it("REDAGUOTAS siunčiamas be jokio papildomo patvirtinimo", async () => {
    const requests = [];
    window.confirm = vi.fn(() => true);

    await renderWithProtocol(mockBackend({ onExport: (body) => requests.push(body) }));

    fireEvent.click(
      within(screen.getByRole("group", { name: /Redaguotas/ })).getByRole("button", { name: ".txt" })
    );

    await waitFor(() => expect(requests).toHaveLength(1));

    expect(requests[0].variant).toBe("redacted");
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("ORIGINALAS reikalauja patvirtinimo, kuriame įvardyta rizika", async () => {
    const requests = [];
    window.confirm = vi.fn(() => true);

    await renderWithProtocol(mockBackend({ onExport: (body) => requests.push(body) }));

    fireEvent.click(
      within(screen.getByRole("group", { name: /Originalas/ })).getByRole("button", { name: "Word (.docx)" })
    );

    await waitFor(() => expect(requests).toHaveLength(1));

    expect(requests[0].variant).toBe("original");
    expect(window.confirm).toHaveBeenCalledTimes(1);

    // Patvirtinimas be paaiškinimo yra tik kliūtis - jis turi pasakyti, KAS bus faile.
    const message = window.confirm.mock.calls[0][0];
    expect(message).toMatch(/NEREDAGUOT/i);
    expect(message).toMatch(/asmens kod/i);
  });

  it("ATŠAUKUS patvirtinimą užklausa NESIUNČIAMA", async () => {
    const requests = [];
    window.confirm = vi.fn(() => false);

    await renderWithProtocol(mockBackend({ onExport: (body) => requests.push(body) }));

    fireEvent.click(
      within(screen.getByRole("group", { name: /Originalas/ })).getByRole("button", { name: ".txt" })
    );

    // Palaukiam, kad įsitikintume - užklausa neatsiranda ir vėliau.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(requests).toHaveLength(0);
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });

  it("VARIANTAS niekada nenumanomas: kiekviena užklausa jį neša eksplicitiškai", async () => {
    const requests = [];
    window.confirm = vi.fn(() => true);

    await renderWithProtocol(mockBackend({ onExport: (body) => requests.push(body) }));

    for (const [groupName, format] of [
      [/Redaguotas/, ".txt"],
      [/Redaguotas/, "Veiksmai .csv"],
      [/Originalas/, ".txt"],
    ]) {
      fireEvent.click(within(screen.getByRole("group", { name: groupName })).getByRole("button", { name: format }));
      await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    }

    await waitFor(() => expect(requests).toHaveLength(3));

    for (const body of requests) {
      expect(["original", "redacted"]).toContain(body.variant);
    }
    expect(requests.filter((r) => r.variant === "redacted")).toHaveLength(2);
    expect(requests.filter((r) => r.variant === "original")).toHaveLength(1);
  });

  it("API sluoksnis ATMETA užklausą be varianto (gynyba nuo būsimo kliento)", async () => {
    const { exportProtocol } = await import("./api/stenogramaApi.js");

    // UI variantą visada perduoda, bet sluoksnis negali tuo remtis: numatytoji
    // reikšmė čia reikštų tylų pasirinkimą už vartotoją.
    await expect(exportProtocol({ format: "txt", protocol: PROTOCOL })).rejects.toThrow(/variantas privalomas/i);
    await expect(exportProtocol({ format: "txt", variant: "originalas", protocol: PROTOCOL })).rejects.toThrow();
  });
});

describe("#8 frontend: numatytosios reikšmės nėra", () => {
  it("runExport be varianto NETYLI - klaida ateina iš API sluoksnio", async () => {
    const { exportProtocol } = await import("./api/stenogramaApi.js");

    /**
     * `runExport` numatytosios reikšmės neturi sąmoningai. Numatytoji `redacted`
     * atrodytų kaip saugiklis, bet UI variantą visada perduoda - tad ji niekada
     * nebūtų vykdoma, ir mutacija, pakeitusi ją į `original`, praeitų nepastebėta
     * (taip ir nutiko rašant šiuos testus).
     */
    await expect(exportProtocol({ format: "docx", variant: undefined, protocol: PROTOCOL })).rejects.toThrow(
      /variantas privalomas/i
    );
  });
});
