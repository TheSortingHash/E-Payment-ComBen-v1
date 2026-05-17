/**
 * ComBen — Credit Memo (CM) xlsx parser (SPEC §4.1).
 *
 * Landbank emits the CM as an xlsx:
 *   Sheet name: <TRN>_P
 *   Rows 1-13:  bank metadata — includes "Transaction Date: MM/DD/YYYY"
 *               and "Transaction Reference Number: <TRN>"
 *   Header row: SOURCE ACCOUNT | DESTINATION ACCOUNT | AMOUNT CREDITED
 *               | TRANSACTION DATE/TIME | REMARKS
 *   Data rows:  accounts as text, amounts in PHP, datetime string
 *   Footer:     "TOTAL COUNT: N", "TOTAL AMOUNT DEBITED: ..."
 *
 * The header-row index can drift between bank exports, so the parser
 * searches for the row containing "DESTINATION ACCOUNT" rather than
 * assuming row 14. Uses the Drive Advanced Service to convert
 * xlsx → temporary Sheet (same pattern as parseUploadXlsx).
 */

function _cmFindCol(cells, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const idx = cells.indexOf(candidates[i]);
    if (idx !== -1) return idx;
  }
  return -1;
}

function _cmParseAmount(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number') return val;
  const s = String(val).replace(/[₱,\s]/g, '').trim();
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function _cmFormatDateTime(val) {
  if (val == null || val === '') return '';
  if (Object.prototype.toString.call(val) === '[object Date]') {
    return Utilities.formatDate(val, TZ, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(val).trim();
}

/**
 * Parse a Credit Memo xlsx Drive file.
 *
 * @param {string} cmFileId  Drive file ID of the CM xlsx.
 * @return {{trn: string, transactionDate: string, rows: object[]}}
 *   rows[i] = { sourceAccount, destinationAccount, amountCredited,
 *               txDateTime, remarks }
 */
function parseCMXlsx(cmFileId) {
  const blob = DriveApp.getFileById(cmFileId).getBlob();
  const tempResource = { title: '__comben_cm_parse_' + Date.now() };
  const tempFile = Drive.Files.insert(tempResource, blob, { convert: true });
  try {
    const tempSs = SpreadsheetApp.openById(tempFile.id);
    const sheet = tempSs.getSheets()[0];
    if (!sheet) throw new Error('parseCMXlsx: no sheet found in CM file');
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2) throw new Error('parseCMXlsx: CM file is empty');
    const raw = sheet.getRange(1, 1, lastRow, Math.max(lastCol, 5)).getValues();

    // 1. Locate the header row (the one with "DESTINATION ACCOUNT").
    let headerIdx = -1;
    let colMap = null;
    for (let i = 0; i < raw.length; i++) {
      const cells = raw[i].map(function (c) {
        return String(c == null ? '' : c).toUpperCase().trim();
      });
      const destIdx = cells.indexOf('DESTINATION ACCOUNT');
      if (destIdx !== -1) {
        headerIdx = i;
        colMap = {
          source: cells.indexOf('SOURCE ACCOUNT'),
          dest: destIdx,
          amount: _cmFindCol(cells, ['AMOUNT CREDITED', 'AMOUNT']),
          datetime: _cmFindCol(cells, [
            'TRANSACTION DATE/TIME', 'TRANSACTION DATE / TIME',
            'TRANSACTION DATETIME', 'DATE/TIME',
          ]),
          remarks: cells.indexOf('REMARKS'),
        };
        break;
      }
    }
    if (headerIdx === -1) {
      throw new Error('parseCMXlsx: could not find the CM header row (no "DESTINATION ACCOUNT" column)');
    }
    if (colMap.amount === -1) {
      throw new Error('parseCMXlsx: could not find an "AMOUNT CREDITED" column in the CM header');
    }

    // 2. Scan metadata rows above the header for the TRN and date.
    let trn = '';
    let transactionDate = '';
    for (let i = 0; i < headerIdx; i++) {
      for (let j = 0; j < raw[i].length; j++) {
        const txt = String(raw[i][j] == null ? '' : raw[i][j]);
        const trnMatch = txt.match(/Transaction\s+Reference\s+Number\s*:?\s*(.+)/i);
        if (trnMatch) trn = trnMatch[1].trim();
        const dateMatch = txt.match(/Transaction\s+Date\s*:?\s*(.+)/i);
        if (dateMatch && !/date\s*\/?\s*time/i.test(txt)) transactionDate = dateMatch[1].trim();
      }
    }

    // 3. Read data rows until a footer marker or blank destination.
    const rows = [];
    for (let i = headerIdx + 1; i < raw.length; i++) {
      const r = raw[i];
      const dest = String(r[colMap.dest] == null ? '' : r[colMap.dest]).trim();
      const firstCell = String(r[0] == null ? '' : r[0]).toUpperCase();
      if (/TOTAL\s+COUNT|TOTAL\s+AMOUNT/.test(firstCell) ||
          /TOTAL\s+COUNT|TOTAL\s+AMOUNT/.test(dest.toUpperCase())) {
        break;
      }
      if (dest === '') continue;
      rows.push({
        sourceAccount: String(r[colMap.source] == null ? '' : r[colMap.source]).trim(),
        destinationAccount: dest,
        amountCredited: _cmParseAmount(r[colMap.amount]),
        txDateTime: colMap.datetime > -1 ? _cmFormatDateTime(r[colMap.datetime]) : '',
        remarks: colMap.remarks > -1 ? String(r[colMap.remarks] == null ? '' : r[colMap.remarks]).trim() : '',
      });
    }

    return { trn: trn, transactionDate: transactionDate, rows: rows };
  } finally {
    try { DriveApp.getFileById(tempFile.id).setTrashed(true); } catch (_e) {}
  }
}
