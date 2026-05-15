/**
 * ComBen — local Payee_Database access layer (SPEC §0.3 REVISED).
 *
 * v1 reads from the local `Payee_Database` sheet rather than calling
 * Treasury's bridge web app. Return shapes mirror SCHEMA §A's "bridge
 * response shape" so when the bridge is eventually built (SPEC §15
 * deferred), call sites swap from these functions to `UrlFetchApp`
 * without changing their interface.
 *
 * Function map (v1 → eventual bridge):
 *   payeeLookup        → GET ?op=lookup
 *   payeeAddDirect     → POST ?op=add
 *   payeeModifyDirect  → POST ?op=modify
 *   payeeRemoveDirect  → POST ?op=remove
 *
 * Bulk + list helpers exist for v1 only; the bridge has no equivalent
 * today. Phase 1 upload validation (Slice 4) uses payeeBulkLookup so
 * a 372-row payroll doesn't trigger 372 individual sheet scans.
 *
 * REMOVE is hard-delete in v1. The SPEC §15 "soft delete preferred"
 * note targets the bridge; to keep the local sheet's column shape
 * matching Treasury's exactly we don't add a Removed_At column. The
 * Audit_Log preserves removal history. Switching to soft delete later
 * is one column add plus a change in payeeRemoveDirect.
 */

const PAYEE_DB_SHEET = 'Payee_Database';
const PAYEE_COL_NAME    = 1;
const PAYEE_COL_ACCOUNT = 2;
const PAYEE_COL_EMAIL   = 3;
const PAYEE_COL_HRIS    = 4;
const PAYEE_INACTIVE_EMAIL_SENTINEL = 'inactive employee';

function _payee_getSheet(ss) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(PAYEE_DB_SHEET);
  if (!sheet) {
    throw new Error(PAYEE_DB_SHEET + ' sheet missing — run setupComBenSchema().');
  }
  return sheet;
}

function _payee_findRow(sheet, paddedHrisId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const ids = sheet.getRange(2, PAYEE_COL_HRIS, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    const cell = ids[i][0];
    if (cell == null || String(cell).trim() === '') continue;
    if (padHrisId(cell) === paddedHrisId) return i + 2;
  }
  return 0;
}

function _payee_rowToRecord(row) {
  const email = String(row[PAYEE_COL_EMAIL - 1] || '').trim();
  const isActiveEmail = email !== '' &&
    email.toLowerCase() !== PAYEE_INACTIVE_EMAIL_SENTINEL;
  return {
    found: true,
    hris_id: padHrisId(row[PAYEE_COL_HRIS - 1]),
    payee_name: String(row[PAYEE_COL_NAME - 1] || ''),
    landbank_account: normalizeAccount(row[PAYEE_COL_ACCOUNT - 1]),
    email: email,
    is_active_email: isActiveEmail,
  };
}

/**
 * Single-payee lookup. O(N) scan of the HRIS column. For batch
 * lookups (e.g. upload validation against an entire roster) use
 * payeeBulkLookup.
 */
function payeeLookup(hrisId) {
  const padded = padHrisId(hrisId);
  const sheet = _payee_getSheet();
  const rowIdx = _payee_findRow(sheet, padded);
  if (rowIdx === 0) return { found: false, hris_id: padded };
  const row = sheet.getRange(rowIdx, 1, 1, 4).getValues()[0];
  return _payee_rowToRecord(row);
}

/**
 * Reads Payee_Database once and returns a Map keyed by padded HRIS_ID
 * with one entry per requested ID. Not-found entries have
 * `{ found:false, hris_id }`; found entries have the full record.
 */
function payeeBulkLookup(hrisIds) {
  const result = new Map();
  if (!Array.isArray(hrisIds)) return result;
  const padded = hrisIds.map(function (id) { return padHrisId(id); });
  for (let i = 0; i < padded.length; i++) {
    result.set(padded[i], { found: false, hris_id: padded[i] });
  }
  const sheet = _payee_getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return result;
  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (row[PAYEE_COL_HRIS - 1] == null || String(row[PAYEE_COL_HRIS - 1]).trim() === '') continue;
    const id = padHrisId(row[PAYEE_COL_HRIS - 1]);
    if (result.has(id)) result.set(id, _payee_rowToRecord(row));
  }
  return result;
}

function payeeListAll() {
  const sheet = _payee_getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  const out = [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    if (row[PAYEE_COL_HRIS - 1] == null || String(row[PAYEE_COL_HRIS - 1]).trim() === '') continue;
    out.push(_payee_rowToRecord(row));
  }
  return out;
}

function payeeAddDirect(record) {
  return withPayeeDatabaseLock(function () {
    if (!record || record.hris_id == null) {
      throw new Error('payeeAddDirect: hris_id is required');
    }
    if (!isValidHrisId(record.hris_id)) {
      throw new Error('payeeAddDirect: invalid HRIS_ID "' + record.hris_id + '"');
    }
    const paddedHris = padHrisId(record.hris_id);
    const sheet = _payee_getSheet();
    if (_payee_findRow(sheet, paddedHris) !== 0) {
      throw new Error('payeeAddDirect: HRIS_ID ' + paddedHris + ' already exists');
    }
    const ctx = 'HRIS_ID ' + paddedHris;
    const paddedAcct = padAccount(record.landbank_account, ctx);
    sheet.appendRow([
      String(record.payee_name || '').trim(),
      paddedAcct,
      String(record.email || '').trim(),
      paddedHris,
    ]);
    return payeeLookup(paddedHris);
  });
}

function payeeModifyDirect(hrisId, after) {
  return withPayeeDatabaseLock(function () {
    const padded = padHrisId(hrisId);
    const sheet = _payee_getSheet();
    const rowIdx = _payee_findRow(sheet, padded);
    if (rowIdx === 0) {
      throw new Error('payeeModifyDirect: HRIS_ID ' + padded + ' not found');
    }
    const beforeRow = sheet.getRange(rowIdx, 1, 1, 4).getValues()[0];
    const before = _payee_rowToRecord(beforeRow);

    const newName  = (after && after.payee_name != null)
      ? String(after.payee_name).trim()
      : beforeRow[PAYEE_COL_NAME - 1];
    const newAcct  = (after && after.landbank_account != null)
      ? padAccount(after.landbank_account, 'HRIS_ID ' + padded)
      : beforeRow[PAYEE_COL_ACCOUNT - 1];
    const newEmail = (after && after.email != null)
      ? String(after.email).trim()
      : beforeRow[PAYEE_COL_EMAIL - 1];
    // HRIS_ID is the primary key — disallow change.
    sheet.getRange(rowIdx, 1, 1, 4).setValues([[newName, newAcct, newEmail, padded]]);
    return { before: before, after: payeeLookup(padded) };
  });
}

function payeeRemoveDirect(hrisId) {
  return withPayeeDatabaseLock(function () {
    const padded = padHrisId(hrisId);
    const sheet = _payee_getSheet();
    const rowIdx = _payee_findRow(sheet, padded);
    if (rowIdx === 0) {
      throw new Error('payeeRemoveDirect: HRIS_ID ' + padded + ' not found');
    }
    const beforeRow = sheet.getRange(rowIdx, 1, 1, 4).getValues()[0];
    const before = _payee_rowToRecord(beforeRow);
    sheet.deleteRow(rowIdx);
    return { before: before, removed_row_index: rowIdx };
  });
}
