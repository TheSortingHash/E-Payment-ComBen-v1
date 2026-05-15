/**
 * ComBen — Drive folder helpers (SPEC §6, §5.3, §10.9).
 *
 * Tree:
 *   <ComBen_Drive_Root>/
 *     _archive/
 *     <YYYY>/<MM-Month>/<BatchNo>/
 *       LINE_ITEMS_*.json, FINDES_*.csv, CM_*_<TRN>.xlsx,
 *       Annex_H_*.pdf, Held_Records_Report_*.pdf,
 *       PAYROLL_UPLOAD_*.xlsx, supporting_docs/, _releases/<SubBatch>/
 *
 * Year and month are derived from the parsed Batch_No (SPEC §10.9).
 */

const MONTH_NAMES = [
  null, // 1-based for arithmetic clarity
  '01-January',   '02-February', '03-March',     '04-April',
  '05-May',       '06-June',     '07-July',      '08-August',
  '09-September', '10-October',  '11-November',  '12-December',
];

/**
 * Parse the Batch_No format `[mm][L][CODE][yy]`, optionally with a
 * `_NN` sub-batch suffix (SPEC §0.4, §5.3).
 *
 *   '04APBP26'    → { mm:'04', letter:'A', code:'PBP', yy:'26', year:'2026', month:4, subBatchSeq:null }
 *   '04APBP26_02' → { …, subBatchSeq:'02' }
 */
function parseBatchNo(batchNo) {
  const m = String(batchNo || '').match(/^(\d{2})([A-Z])([A-Z]{2,5})(\d{2})(?:_(\d{2}))?$/);
  if (!m) throw new Error('parseBatchNo: invalid Batch_No "' + batchNo + '"');
  const month = parseInt(m[1], 10);
  if (month < 1 || month > 12) {
    throw new Error('parseBatchNo: invalid month "' + m[1] + '" in "' + batchNo + '"');
  }
  return {
    mm: m[1],
    letter: m[2],
    code: m[3],
    yy: m[4],
    year: '20' + m[4],
    month: month,
    subBatchSeq: m[5] || null,
  };
}

// _drive_readConfig (not _readConfigValue) avoids a global-namespace
// collision with Schema.gs's helper of the same name. Apps Script has
// a single namespace across all .gs files; whichever loads later wins,
// and Schema's helper (looser — returns '' on missing sheet) would
// silently replace this stricter version.
function _drive_readConfig(ss, key) {
  const sheet = ss.getSheetByName('Config');
  if (!sheet) throw new Error('Config sheet missing — run setupComBenSchema()');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === key) return String(data[i][1] || '').trim();
  }
  return '';
}

function getComBenRoot(ss) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  const id = _drive_readConfig(spreadsheet, 'combenDriveRootFolderId');
  if (!id) {
    throw new Error('combenDriveRootFolderId is not set in Config — set it and re-run setupComBenSchema().');
  }
  return DriveApp.getFolderById(id);
}

function _ensureChildFolder(parent, name) {
  const iter = parent.getFoldersByName(name);
  return iter.hasNext() ? iter.next() : parent.createFolder(name);
}

function ensureYearFolder(year, ss) {
  return _ensureChildFolder(getComBenRoot(ss), String(year));
}

function ensureMonthFolder(year, month, ss) {
  const m = parseInt(month, 10);
  if (m < 1 || m > 12) throw new Error('ensureMonthFolder: month must be 1-12, got ' + month);
  return _ensureChildFolder(ensureYearFolder(year, ss), MONTH_NAMES[m]);
}

/**
 * Ensure `<root>/<YYYY>/<MM-Month>/<BatchNo>/` exists and return it.
 * For sub-batches (Batch_No ends in `_NN`), the resolved path is
 * `<parentBatchFolder>/_releases/<SubBatchNo>/` per SPEC §5.3.
 */
function ensureBatchFolder(batchNo, ss) {
  const parts = parseBatchNo(batchNo);
  const monthFolder = ensureMonthFolder(parts.year, parts.month, ss);
  if (parts.subBatchSeq) {
    const parentNo = batchNo.slice(0, batchNo.lastIndexOf('_'));
    const parentFolder = _ensureChildFolder(monthFolder, parentNo);
    const releases = _ensureChildFolder(parentFolder, '_releases');
    return _ensureChildFolder(releases, batchNo);
  }
  return _ensureChildFolder(monthFolder, batchNo);
}

function ensureSupportingDocsFolder(batchNo, ss) {
  return _ensureChildFolder(ensureBatchFolder(batchNo, ss), 'supporting_docs');
}

function ensureArchiveFolder(ss) {
  return _ensureChildFolder(getComBenRoot(ss), '_archive');
}
