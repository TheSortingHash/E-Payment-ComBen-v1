/**
 * ComBen — Batch head-row and LINE_ITEMS JSON I/O (SPEC §2.2, §2.3, §14.5).
 *
 * Head row lives in Master_Payroll_Batches_<YYYY> (hot). Line items
 * live in <batch>/LINE_ITEMS_<BatchNo>.json on Drive (cold). SHA256
 * over the line-items JSON is stored on the head row and re-verified
 * on every read; mismatch raises and emits INTEGRITY_VIOLATION.
 *
 * All callers should wrap mutations in withBatchLock(batchNo, fn).
 */

const _MPB_COL = {
  Batch_No: 1,            Parent_Batch_No: 2,        Payroll_Type: 3,
  Period_Covered: 4,      Status: 5,                 Active_Count: 6,
  Hold_Count: 7,          Total_Released: 8,         Total_Held: 9,
  Uploader_Name: 10,      Uploader_Email: 11,        Created_At: 12,
  Line_Items_File_ID: 13, Line_Items_SHA256: 14,     Supporting_Docs_Folder_ID: 15,
  FINDES_File_ID: 16,     FINDES_SHA256: 17,         CM_File_ID: 18,
  CM_TRN: 19,             Bank_TX_DateTime: 20,      Annex_H_File_ID: 21,
  Annex_H_Report_No: 22,  Handoff_Email_Sent_At: 23, Closed_At: 24,
  Notes: 25,
};
const _MPB_LAST_COL = 25;

function _mpbSheet(year, ss) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  const name = 'Master_Payroll_Batches_' + year;
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error(name + ' missing — run setupComBenSchema().');
  return sheet;
}

function _mpbFindRow(sheet, batchNo) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const ids = sheet.getRange(2, _MPB_COL.Batch_No, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === batchNo) return i + 2;
  }
  return 0;
}

function _mpbRowToObject(values) {
  const obj = {};
  Object.keys(_MPB_COL).forEach(function (k) {
    obj[k] = values[_MPB_COL[k] - 1];
  });
  return obj;
}

function batchHeadRead(batchNo, ss) {
  const parts = parseBatchNo(batchNo);
  const sheet = _mpbSheet(parts.year, ss);
  const rowIdx = _mpbFindRow(sheet, batchNo);
  if (rowIdx === 0) return null;
  const values = sheet.getRange(rowIdx, 1, 1, _MPB_LAST_COL).getValues()[0];
  return _mpbRowToObject(values);
}

function batchHeadInsert(head, ss) {
  const parts = parseBatchNo(head.Batch_No);
  const sheet = _mpbSheet(parts.year, ss);
  if (_mpbFindRow(sheet, head.Batch_No) !== 0) {
    throw new Error('batchHeadInsert: batch ' + head.Batch_No + ' already exists');
  }
  const row = new Array(_MPB_LAST_COL).fill('');
  Object.keys(_MPB_COL).forEach(function (k) {
    if (head[k] != null) row[_MPB_COL[k] - 1] = head[k];
  });
  sheet.appendRow(row);
}

function batchHeadUpdate(batchNo, partial, ss) {
  const parts = parseBatchNo(batchNo);
  const sheet = _mpbSheet(parts.year, ss);
  const rowIdx = _mpbFindRow(sheet, batchNo);
  if (rowIdx === 0) throw new Error('batchHeadUpdate: batch ' + batchNo + ' not found');
  Object.keys(partial).forEach(function (k) {
    if (_MPB_COL[k] != null) {
      sheet.getRange(rowIdx, _MPB_COL[k]).setValue(partial[k]);
    }
  });
}

/**
 * Write LINE_ITEMS_<BatchNo>.json and update head row's
 * Line_Items_File_ID + Line_Items_SHA256. If a file already exists,
 * overwrite its content in place (preserving the Drive file ID so
 * existing links don't break).
 */
function lineItemsWrite(batchNo, lineItemsArray, ss) {
  const head = batchHeadRead(batchNo, ss);
  // head may be null when batch_create is mid-flight: callers must
  // batchHeadInsert(...) first so the row exists, then lineItemsWrite.
  if (!head) throw new Error('lineItemsWrite: batch ' + batchNo + ' head row missing');

  const folder = ensureBatchFolder(batchNo, ss);
  const filename = 'LINE_ITEMS_' + batchNo + '.json';
  const json = JSON.stringify(lineItemsArray, null, 2);
  const sha = sha256Hex(json);

  let file;
  if (head.Line_Items_File_ID) {
    try {
      file = DriveApp.getFileById(head.Line_Items_File_ID);
      file.setContent(json);
    } catch (_e) {
      file = folder.createFile(filename, json, 'application/json');
    }
  } else {
    file = folder.createFile(filename, json, 'application/json');
  }

  batchHeadUpdate(batchNo, {
    Line_Items_File_ID: file.getId(),
    Line_Items_SHA256: sha,
  }, ss);
  return { fileId: file.getId(), sha256: sha, count: lineItemsArray.length };
}

function lineItemsRead(batchNo, ss) {
  const head = batchHeadRead(batchNo, ss);
  if (!head) throw new Error('lineItemsRead: batch ' + batchNo + ' not found');
  if (!head.Line_Items_File_ID) {
    throw new Error('lineItemsRead: batch ' + batchNo + ' has no line-items file');
  }
  const file = DriveApp.getFileById(head.Line_Items_File_ID);
  const json = file.getBlob().getDataAsString();
  const sha = sha256Hex(json);
  if (sha !== head.Line_Items_SHA256) {
    audit({
      action: 'INTEGRITY_VIOLATION',
      actor: 'SYSTEM',
      role: 'SYSTEM',
      targetType: 'BATCH',
      targetId: batchNo,
      note: 'LINE_ITEMS_' + batchNo + '.json SHA256 mismatch (got ' + sha +
            ', expected ' + head.Line_Items_SHA256 + ')',
    });
    throw new Error('INTEGRITY: Line items hash mismatch for batch ' + batchNo);
  }
  let parsed;
  try { parsed = JSON.parse(json); }
  catch (e) { throw new Error('lineItemsRead: malformed JSON: ' + e.message); }
  return { items: parsed, sha256: sha };
}
