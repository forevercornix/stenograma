/**
 * Rankomis parašyta, priklausomybių nereikalaujanti schema validacija.
 * Jei projektas auga, verta pereiti prie `zod` arba `ajv` - sąsaja (validate())
 * liktų ta pati, tad tai nekeistų likusio kodo.
 */

const REQUIRED_TOP_LEVEL = [
  "pavadinimas",
  "data",
  "dalyviai",
  "darbotvarke",
  "aptarti_klausimai",
  "nutarimai",
  "veiksmai",
];

function validate(obj) {
  const errors = [];

  if (typeof obj !== "object" || obj === null) {
    return { valid: false, errors: ["Rezultatas nėra objektas"] };
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in obj)) errors.push(`Trūksta lauko "${key}"`);
  }

  if (obj.pavadinimas !== undefined && typeof obj.pavadinimas !== "string")
    errors.push('"pavadinimas" turi būti string');

  if (obj.dalyviai !== undefined && !Array.isArray(obj.dalyviai))
    errors.push('"dalyviai" turi būti masyvas');

  if (obj.darbotvarke !== undefined && !Array.isArray(obj.darbotvarke))
    errors.push('"darbotvarke" turi būti masyvas');

  if (obj.aptarti_klausimai !== undefined) {
    if (!Array.isArray(obj.aptarti_klausimai)) {
      errors.push('"aptarti_klausimai" turi būti masyvas');
    } else {
      obj.aptarti_klausimai.forEach((k, i) => {
        if (typeof k?.klausimas !== "string")
          errors.push(`aptarti_klausimai[${i}].klausimas turi būti string`);
        if (typeof k?.santrauka !== "string")
          errors.push(`aptarti_klausimai[${i}].santrauka turi būti string`);
      });
    }
  }

  if (obj.nutarimai !== undefined && !Array.isArray(obj.nutarimai))
    errors.push('"nutarimai" turi būti masyvas');

  if (obj.veiksmai !== undefined) {
    if (!Array.isArray(obj.veiksmai)) {
      errors.push('"veiksmai" turi būti masyvas');
    } else {
      obj.veiksmai.forEach((v, i) => {
        if (typeof v?.uzduotis !== "string") errors.push(`veiksmai[${i}].uzduotis turi būti string`);
        if (typeof v?.atsakingas !== "string") errors.push(`veiksmai[${i}].atsakingas turi būti string`);
        if (typeof v?.terminas !== "string") errors.push(`veiksmai[${i}].terminas turi būti string`);
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Bando išparsinti LLM atsakymą į JSON. Jei nepavyksta arba schema nevalidi,
 * grąžina informaciją, kad iškviečiantis kodas galėtų paprašyti LLM "repair" žingsnio.
 */
function tryParse(rawText) {
  const cleaned = rawText
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const obj = JSON.parse(cleaned);
    const { valid, errors } = validate(obj);
    return { success: valid, data: obj, errors };
  } catch (e) {
    return { success: false, data: null, errors: [`JSON parse klaida: ${e.message}`] };
  }
}

function buildRepairPrompt(rawText, errors) {
  return `Ankstesnis atsakymas turėjo būti griežtai validus JSON, bet nebuvo. Klaidos:
${errors.map((e) => "- " + e).join("\n")}

Ankstesnis (netinkamas) atsakymas:
"""
${rawText}
"""

Grąžink IŠTAISYTĄ, griežtai validų JSON objektą, be markdown, be paaiškinimų, be \`\`\` žymų. Nekeisk turinio prasmės, tik ištaisyk struktūrą/formatą.`;
}

module.exports = { validate, tryParse, buildRepairPrompt, REQUIRED_TOP_LEVEL };
