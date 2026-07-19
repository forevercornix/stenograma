/**
 * Minimalus audit log. MVP lygyje - atmintyje (masyvas).
 * Produkcijai: pakeisti į SQLite/Postgres lentelę su tais pačiais laukais -
 * likusio kodo (record()) keisti nereikės.
 */
const log = [];

function record(entry) {
  const row = {
    id: log.length + 1,
    timestamp: new Date().toISOString(),
    meetingId: entry.meetingId || null,
    promptVersion: entry.promptVersion || null,
    llmProvider: entry.llmProvider || null,
    llmModel: entry.llmModel || null,
    transcriptionProvider: entry.transcriptionProvider || null,
    diarizationProvider: entry.diarizationProvider || null,
    processingTimeMs: entry.processingTimeMs ?? null,
    inputTokens: entry.usage?.inputTokens ?? null,
    outputTokens: entry.usage?.outputTokens ?? null,
    estimatedCostUsd: entry.estimatedCostUsd ?? null,
    jsonRepairAttempts: entry.jsonRepairAttempts ?? 0,
    success: entry.success ?? true,
    error: entry.error || null,
  };
  log.push(row);
  return row;
}

function getAll() {
  return log;
}

module.exports = { record, getAll };
