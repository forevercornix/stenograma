const Papa = require("papaparse");

/**
 * PROTOKOLŲ EKSPORTAS SERVERIO PUSĖJE (GDPR issue #6).
 *
 * Anksčiau visi trys formatai buvo generuojami naršyklėje. Dėl to eksporto
 * įvykių audito žurnale iš principo negalėjo būti: serveris apie juos nieko
 * nežinojo. Perkėlus generavimą čia, `EXPORT_*` įvykiai yra SERVERIO žinojimas,
 * o ne kliento pranešimas (kuriuo audite negalima pasitikėti).
 *
 * Turinys niekur nelogguojamas - grąžinamas tik atsakyme.
 */

const FORMATS = { TXT: "txt", CSV: "csv", DOCX: "docx" };

const BRASS = "9C7A34"; // eslint-disable-line no-unused-vars -- rezervuota firminiam stiliui
const SLATE = "5B6472";

function _list(items) {
  return Array.isArray(items) ? items : [];
}

function _safeDate(protocol) {
  const raw = String(protocol.data || "").trim();
  // Failo vardui - tik saugūs simboliai (raktas: nepatikimas LLM/vartotojo įvesties laukas).
  const cleaned = raw.replace(/[^0-9A-Za-z-]/g, "");
  return cleaned || new Date().toISOString().slice(0, 10);
}

function buildTxt(protocol) {
  const nested = (items) =>
    _list(items)
      .map((k, i) => `${i + 1}. ${k.klausimas}\n   ${k.santrauka}`)
      .join("\n") || "Nenurodyta";

  const numbered = (items) =>
    _list(items).map((d, i) => `${i + 1}. ${d}`).join("\n") || "Nenurodyta";

  let out = `PROTOKOLAS\n${protocol.pavadinimas || ""}\nData: ${protocol.data || ""}\n\n`;
  out += `DALYVIAI:\n${_list(protocol.dalyviai).map((d) => "- " + d).join("\n") || "Nenurodyta"}\n\n`;
  out += `DARBOTVARKĖ:\n${numbered(protocol.darbotvarke)}\n\n`;
  out += `APTARTI KLAUSIMAI:\n${nested(protocol.aptarti_klausimai)}\n\n`;
  out += `NUTARIMAI:\n${numbered(protocol.nutarimai)}\n\n`;
  out += `VEIKSMAI:\n${
    _list(protocol.veiksmai)
      .map((v) => `- ${v.uzduotis} | Atsakingas: ${v.atsakingas} | Terminas: ${v.terminas}`)
      .join("\n") || "Nenurodyta"
  }\n`;

  return { buffer: Buffer.from(out, "utf8"), filename: `protokolas_${_safeDate(protocol)}.txt`, contentType: "text/plain; charset=utf-8" };
}

function buildCsv(protocol) {
  const rows = _list(protocol.veiksmai).map((v) => ({
    Užduotis: v.uzduotis,
    Atsakingas: v.atsakingas,
    Terminas: v.terminas,
  }));

  const csv = Papa.unparse(rows.length ? rows : [{ Užduotis: "", Atsakingas: "", Terminas: "" }], {
    // CSV FORMULA INJECTION apsauga. `veiksmai` turinys ateina iš LLM arba
    // vartotojo, tad reikšmė, prasidedanti `=`, `+`, `-` ar `@`, Excel'yje /
    // LibreOffice'e būtų vykdoma kaip FORMULĖ, ne rodoma kaip tekstas
    // (pvz. `=HYPERLINK("https://evil.example","Atidaryti")`).
    // Papa prideda apostrofą, tad reikšmė lieka tekstu.
    escapeFormulae: true,
  });

  // BOM - kad Excel atidarytų UTF-8 teisingai (toks pat elgesys kaip anksčiau naršyklėje).
  return {
    buffer: Buffer.from("\uFEFF" + csv, "utf8"),
    filename: `veiksmai_${_safeDate(protocol)}.csv`,
    contentType: "text/csv; charset=utf-8",
  };
}

async function buildDocx(protocol) {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType,
  } = require("docx");

  const heading2 = (text) =>
    new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 120 } });

  const placeholder = () =>
    new Paragraph({ children: [new TextRun({ text: "Nenurodyta", italics: true, color: SLATE })] });

  const bulletList = (items) =>
    _list(items).length
      ? _list(items).map((item) => new Paragraph({ text: String(item), bullet: { level: 0 } }))
      : [placeholder()];

  const cell = (text, opts = {}) =>
    new TableCell({
      width: { size: opts.width || 33, type: WidthType.PERCENTAGE },
      children: [new Paragraph({ children: [new TextRun({ text: text || "", bold: opts.bold })] })],
    });

  const veiksmai = _list(protocol.veiksmai);
  const veiksmaiRows = [
    new TableRow({
      children: [
        cell("Užduotis", { bold: true }),
        cell("Atsakingas", { bold: true }),
        cell("Terminas", { bold: true }),
      ],
    }),
    ...(veiksmai.length
      ? veiksmai.map((v) => new TableRow({ children: [cell(v.uzduotis), cell(v.atsakingas), cell(v.terminas)] }))
      : [new TableRow({ children: [cell("Nenurodyta"), cell(""), cell("")] })]),
  ];

  const klausimai = _list(protocol.aptarti_klausimai);

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            children: [new TextRun({ text: "PROTOKOLAS", bold: true, size: 22, color: SLATE })],
            spacing: { after: 200 },
          }),
          new Paragraph({ children: [new TextRun({ text: protocol.pavadinimas || "", bold: true, size: 32 })] }),
          new Paragraph({
            children: [new TextRun({ text: `Data: ${protocol.data || ""}`, color: SLATE, size: 20 })],
            spacing: { after: 200 },
          }),

          heading2("Dalyviai"),
          new Paragraph({ text: _list(protocol.dalyviai).join(", ") || "Nenurodyta" }),

          heading2("Darbotvarkė"),
          ...bulletList(protocol.darbotvarke),

          heading2("Aptarti klausimai"),
          ...(klausimai.length
            ? klausimai.flatMap((k) => [
                new Paragraph({ children: [new TextRun({ text: k.klausimas || "", bold: true })] }),
                new Paragraph({ text: k.santrauka || "", spacing: { after: 120 } }),
              ])
            : [placeholder()]),

          heading2("Nutarimai"),
          ...bulletList(protocol.nutarimai),

          heading2("Veiksmai"),
          new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: veiksmaiRows }),

          new Paragraph({ text: "", spacing: { before: 600 } }),
          new Paragraph({ text: "_____________________________" }),
          new Paragraph({ text: "Protokolą parengė (parašas, vardas pavardė)", spacing: { before: 60 } }),
        ],
      },
    ],
  });

  return {
    buffer: await Packer.toBuffer(doc),
    filename: `protokolas_${_safeDate(protocol)}.docx`,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}

/**
 * @param {object} protocol - protokolo JSON (turinys NIEKUR nelogguojamas)
 * @param {"txt"|"csv"|"docx"} format
 */
async function buildExport(protocol, format) {
  switch (String(format || "").toLowerCase()) {
    case FORMATS.TXT:
      return buildTxt(protocol);
    case FORMATS.CSV:
      return buildCsv(protocol);
    case FORMATS.DOCX:
      return buildDocx(protocol);
    default:
      return null;
  }
}

module.exports = { buildExport, buildTxt, buildCsv, buildDocx, FORMATS };
