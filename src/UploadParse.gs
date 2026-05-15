/**
 * ComBen — XLSX upload parsing (Phase 1; SPEC §2.1).
 *
 * Uses Drive's xlsx-to-Sheet conversion to read the 3-column payroll
 * upload file. Requires the Drive Advanced Service (enabled in
 * appsscript.json).
 *
 * Expected shape (no metadata sheet, no instruction sheet):
 *   Column 1: HRIS_ID   — text, 6 chars, leading zeros preserved
 *   Column 2: HRIS_Name — text
 *   Column 3: Amount    — decimal PHP, > 0
 *
 * Tolerates an optional header row (auto-detected when the first
 * row's first cell is non-numeric), leading/trailing whitespace, and
 * thousand-separator commas in Amount.
 */

function _looksLikeHeaderRow(row) {
  if (!row || row.length < 3) return false;
  const c1 = String(row[0] || '').trim();
  if (c1 === '') return false;
  if (/^\d+$/.test(c1)) return false;
  return true;
}

function _parseAmount(val) {
  if (val == null || val === '') return null;
  const s = String(val).replace(/,/g, '').trim();
  const n = Number(s);
  if (!isFinite(n)) return null;
  return n;
}

/**
 * Convert an xlsx Drive file into structured rows.
 *
 * @param {string} xlsxFileId  Drive file ID of the uploaded xlsx.
 * @return {{rows: object[], errors: object[]}}
 *   rows[i]   = { lineNumber, hrisIdRaw, hrisName, amount }
 *   errors[i] = { lineNumber, reason }
 */
function parseUploadXlsx(xlsxFileId) {
  const sourceFile = DriveApp.getFileById(xlsxFileId);
  const blob = sourceFile.getBlob();
  const tempResource = { title: '__comben_upload_parse_' + Date.now() };
  // convert:true tells Drive v2 to convert the xlsx to a Google Sheet.
  const tempFile = Drive.Files.insert(tempResource, blob, { convert: true });
  try {
    const tempSs = SpreadsheetApp.openById(tempFile.id);
    const sheet = tempSs.getSheets()[0];
    if (!sheet) throw new Error('parseUploadXlsx: no sheet found in xlsx');
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow === 0 || lastCol < 3) {
      return {
        rows: [],
        errors: [{ lineNumber: 0, reason: 'File is empty or has fewer than 3 columns' }],
      };
    }
    const raw = sheet.getRange(1, 1, lastRow, 3).getValues();
    const startIdx = _looksLikeHeaderRow(raw[0]) ? 1 : 0;

    const rows = [];
    const errors = [];
    for (let i = startIdx; i < raw.length; i++) {
      const lineNumber = i + 1;
      const r = raw[i];
      const c1 = r[0], c2 = r[1], c3 = r[2];

      // Skip totally blank rows silently.
      const blank =
        (c1 === '' || c1 == null) &&
        (c2 === '' || c2 == null) &&
        (c3 === '' || c3 == null);
      if (blank) continue;

      if (c1 == null || String(c1).trim() === '') {
        errors.push({ lineNumber: lineNumber, reason: 'HRIS_ID is missing' });
        continue;
      }
      const amount = _parseAmount(c3);
      if (amount == null) {
        errors.push({ lineNumber: lineNumber, reason: 'Amount is missing or not numeric: "' + c3 + '"' });
        continue;
      }
      if (amount <= 0) {
        errors.push({ lineNumber: lineNumber, reason: 'Amount must be > 0, got ' + amount });
        continue;
      }

      rows.push({
        lineNumber: lineNumber,
        hrisIdRaw: String(c1),
        hrisName: String(c2 == null ? '' : c2).trim(),
        amount: amount,
      });
    }
    return { rows: rows, errors: errors };
  } finally {
    try { DriveApp.getFileById(tempFile.id).setTrashed(true); } catch (_e) {}
  }
}
