/**
 * ComBen — Sheet schema bootstrap (SPEC §8, SCHEMA §C).
 *
 * Entry points (run from the Apps Script editor or the ComBen Admin
 * spreadsheet menu):
 *
 *   setupComBenSchema()                  — operate on the active spreadsheet
 *   setupComBenSchema('1aBcD…')          — operate on a specific spreadsheet
 *   verifyComBenSchema([spreadsheetId])  — read-only audit
 *
 * Both functions append a row to `_Setup_Log`. setup is idempotent —
 * re-running only adds what is missing, never overwrites existing
 * data, never reorders columns.
 *
 * Notes on partial enforcement:
 *
 *   - Sheet-level data validation is applied for dropdowns (list and
 *     range). Regex / required / numeric / uniqueness rules listed in
 *     SCHEMA.md are enforced server-side (SPEC §14.4 "Client-side
 *     trust: none"); applying them as `requireFormulaSatisfied` cell
 *     validations would only catch typing in the spreadsheet directly
 *     and would clutter the UI. Server validation is the source of
 *     truth in every endpoint.
 *
 *   - Sheet protections are applied as `setWarningOnly(true)` for v1.
 *     SCHEMA flags several sheets as "Admin only" but the Admin email
 *     list lives in `User_Database`, which this script is creating.
 *     A future `applyStrictProtections()` admin action (Slice 13) will
 *     read `User_Database` and convert these to hard protections.
 *
 *   - Drive year/month skeleton (SCHEMA §C step 6) is created only
 *     when `combenDriveRootFolderId` is already populated in `Config`.
 *     First run leaves it blank, the script logs a "skipped" note,
 *     Admin fills the root folder ID and re-runs.
 */

/* =======================================================================
 * Helpers
 * ===================================================================== */

function _now() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function _currentYear() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy');
}

function _resolveName(name, year) {
  return name.replace(/<YYYY>/g, year);
}

function _activeEmail() {
  try {
    const e = Session.getActiveUser && Session.getActiveUser().getEmail();
    return e || 'unknown';
  } catch (_e) {
    return 'unknown';
  }
}

function _ensureSheet(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    return { sheet, created: true };
  }
  return { sheet, created: false };
}

/**
 * Append any missing headers in `columns` to row 1 of `sheet`.
 * Existing headers — wherever they currently sit — are left in place.
 * New headers are appended after `sheet.getLastColumn()` and advance
 * one column per addition.
 */
function _ensureHeaders(sheet, columns) {
  const desired = columns.map(function (c) { return c.header; });
  const lastCol = sheet.getLastColumn();
  let firstRow = [];
  if (lastCol > 0) {
    firstRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) {
      return String(v == null ? '' : v);
    });
  }
  const present = new Set(firstRow.filter(function (h) { return h !== ''; }));
  const added = [];
  let nextCol = lastCol + 1;
  for (let i = 0; i < desired.length; i++) {
    const header = desired[i];
    if (present.has(header)) continue;
    const range = sheet.getRange(1, nextCol);
    range.setValue(header).setFontWeight('bold').setBackground('#F1F3F4');
    added.push({ header: header, column: nextCol });
    nextCol++;
  }
  return added;
}

function _columnIndexByHeader(sheet, header) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return 0;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]) === header) return i + 1;
  }
  return 0;
}

function _applyColumnFormat(sheet, columnIndex, format) {
  if (!format) return;
  const lastRow = Math.max(sheet.getMaxRows(), 2);
  sheet.getRange(2, columnIndex, lastRow - 1, 1).setNumberFormat(format);
}

function _applyColumnValidation(sheet, columnIndex, validation, ss) {
  if (!validation) return;
  let rule;
  if (validation.kind === 'list') {
    rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(validation.values, true)
      .setAllowInvalid(false)
      .build();
  } else if (validation.kind === 'range') {
    const range = ss.getRange(validation.range);
    rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(range, true)
      .setAllowInvalid(false)
      .build();
  } else {
    return;
  }
  const lastRow = Math.max(sheet.getMaxRows(), 2);
  sheet.getRange(2, columnIndex, lastRow - 1, 1).setDataValidation(rule);
}

/**
 * Idempotent conditional-format apply. A rule is treated as
 * already-present if any existing rule on the sheet uses the same
 * boolean formula condition. (Sheets has no rule-equality API; this
 * matches on the most distinctive part.)
 */
function _applyConditionalFormatting(sheet, rules) {
  if (!rules || rules.length === 0) return [];
  const existing = sheet.getConditionalFormatRules();
  const existingFormulas = new Set();
  for (let i = 0; i < existing.length; i++) {
    const cond = existing[i].getBooleanCondition();
    if (!cond) continue;
    const t = cond.getCriteriaType();
    const args = cond.getCriteriaValues() || [];
    if (t === SpreadsheetApp.BooleanCriteria.CUSTOM_FORMULA && args.length > 0) {
      existingFormulas.add(String(args[0]));
    }
  }
  const newRules = existing.slice();
  const added = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (existingFormulas.has(r.whenFormula)) continue;
    const range = sheet.getRange(r.range);
    const built = SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(r.whenFormula)
      .setBackground(r.background)
      .setRanges([range])
      .build();
    newRules.push(built);
    added.push(r);
  }
  if (added.length > 0) {
    sheet.setConditionalFormatRules(newRules);
  }
  return added;
}

function _applyProtectionWarningOnly(sheet, description) {
  if (!description) return false;
  const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  if (existing && existing.length > 0) return false;
  sheet.protect().setDescription(description).setWarningOnly(true);
  return true;
}

/* =======================================================================
 * Per-sheet seed functions
 * ===================================================================== */

function _seedPayrollTypes(sheet) {
  if (sheet.getLastRow() > 1) {
    return { seeded: false, reason: 'rows already present', rowCount: 0 };
  }
  const rows = PAYROLL_TYPES.map(function (pt) {
    return [
      pt.name,
      pt.code,
      pt.quincenaMode ? 'YES' : 'NO',
      pt.holdAllowed ? 'YES' : 'NO',
      DEFAULT_NOTIFICATION_SUBJECT,
      DEFAULT_NOTIFICATION_BODY,
      'YES',
    ];
  });
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  return { seeded: true, rowCount: rows.length };
}

function _seedConfig(sheet) {
  const lastRow = sheet.getLastRow();
  let existingKeys = new Set();
  if (lastRow >= 2) {
    const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < data.length; i++) {
      const k = String(data[i][0] || '');
      if (k) existingKeys.add(k);
    }
  }
  const toAdd = CONFIG_DEFAULTS.filter(function (d) {
    return !existingKeys.has(d.setting);
  });
  if (toAdd.length === 0) return { seeded: false, rowCount: 0, keys: [] };
  const rows = toAdd.map(function (d) { return [d.setting, d.value, d.notes]; });
  const startRow = Math.max(lastRow + 1, 2);
  sheet.getRange(startRow, 1, rows.length, 3).setValues(rows);
  return { seeded: true, rowCount: rows.length, keys: toAdd.map(function (d) { return d.setting; }) };
}

/* =======================================================================
 * Sheet specifications (SCHEMA §1–§10)
 *
 * Order matters: sheets referenced by other sheets' range validations
 * (e.g. Payroll_Types) must come first.
 * ===================================================================== */

const SHEET_SPECS = [
  // SCHEMA §3 — Payroll_Types
  {
    name: 'Payroll_Types',
    yearly: false,
    frozenRows: 1,
    frozenCols: 1,
    protectWarningOnly: 'Admin-managed list — edits affect every downstream batch (SCHEMA §3).',
    columns: [
      { header: 'Payroll_Type',           format: null, validation: null },
      { header: 'Code',                   format: '@',  validation: null },
      { header: 'Quincena_Mode',          format: null, validation: { kind: 'list', values: YES_NO } },
      { header: 'Hold_Allowed',           format: null, validation: { kind: 'list', values: YES_NO } },
      { header: 'Notification_Subject',   format: null, validation: null },
      { header: 'Notification_Body_HTML', format: null, validation: null },
      { header: 'Active',                 format: null, validation: { kind: 'list', values: YES_NO } },
    ],
    conditionalFormatting: null,
    seed: _seedPayrollTypes,
  },

  // SPEC §0.3 (REVISED) — local Payee_Database mirror.
  // Maintained by paste/import from Treasury's master roster until the
  // bridge in SPEC §15 is built. Column headers match Treasury's exact
  // labels (spaces, not underscores) so a copy/paste drops in cleanly.
  // '@' text format on Landbank Account and HRIS Number preserves
  // leading zeros (SPEC §11).
  {
    name: 'Payee_Database',
    yearly: false,
    frozenRows: 1,
    frozenCols: 0,
    columns: [
      { header: 'Payee Name',       format: null, validation: null },
      { header: 'Landbank Account', format: '@',  validation: null },
      { header: 'Email Address',    format: null, validation: null },
      { header: 'HRIS Number',      format: '@',  validation: null },
    ],
  },

  // SCHEMA §4 — Authorizers
  {
    name: 'Authorizers',
    yearly: false,
    frozenRows: 1,
    frozenCols: 0,
    protectWarningOnly: 'Admin-managed roster — Phase 4 endorsement recipients (SCHEMA §4).',
    columns: [
      { header: 'Name',   format: null, validation: null },
      { header: 'Email',  format: null, validation: null },
      { header: 'Title',  format: null, validation: null },
      { header: 'Active', format: null, validation: { kind: 'list', values: YES_NO } },
      { header: 'Notes',  format: null, validation: null },
    ],
  },

  // SCHEMA §5 — User_Database
  {
    name: 'User_Database',
    yearly: false,
    frozenRows: 1,
    frozenCols: 0,
    protectWarningOnly: 'Auth credentials — Admin only. Password_Hash is SHA256(salt + password) (SCHEMA §5).',
    columns: [
      { header: 'Email_Address',  format: null, validation: null },
      { header: 'Password_Hash',  format: '@',  validation: null },
      { header: 'Salt',           format: '@',  validation: null },
      { header: 'Role',           format: null, validation: { kind: 'list', values: USER_ROLES } },
      { header: 'Status',         format: null, validation: { kind: 'list', values: USER_STATUSES } },
      { header: 'Display_Name',   format: null, validation: null },
      { header: 'Created_At',     format: 'yyyy-mm-dd HH:mm:ss', validation: null },
      { header: 'Last_Login_At',  format: 'yyyy-mm-dd HH:mm:ss', validation: null },
    ],
  },

  // SCHEMA §6 — Config
  {
    name: 'Config',
    yearly: false,
    frozenRows: 1,
    frozenCols: 0,
    protectWarningOnly: 'System config — Admin only (SCHEMA §6).',
    columns: [
      { header: 'Setting', format: null, validation: null },
      { header: 'Value',   format: null, validation: null },
      { header: 'Notes',   format: null, validation: null },
    ],
    seed: _seedConfig,
  },

  // SCHEMA §1 — Master_Payroll_Batches_<YYYY>
  {
    name: 'Master_Payroll_Batches_<YYYY>',
    yearly: true,
    frozenRows: 1,
    frozenCols: 1,
    protectWarningOnly: 'Operational head row per batch. Edit non-Draft rows only via the web app (SCHEMA §1).',
    columns: [
      { header: 'Batch_No',                  format: '@',                     validation: null },
      { header: 'Parent_Batch_No',           format: '@',                     validation: null },
      { header: 'Payroll_Type',              format: null,                    validation: { kind: 'range', range: 'Payroll_Types!A2:A' } },
      { header: 'Period_Covered',            format: null,                    validation: null },
      { header: 'Status',                    format: null,                    validation: { kind: 'list', values: BATCH_STATUSES } },
      { header: 'Active_Count',              format: '0',                     validation: null },
      { header: 'Hold_Count',                format: '0',                     validation: null },
      { header: 'Total_Released',            format: '#,##0.00',              validation: null },
      { header: 'Total_Held',                format: '#,##0.00',              validation: null },
      { header: 'Uploader_Name',             format: null,                    validation: null },
      { header: 'Uploader_Email',            format: null,                    validation: null },
      { header: 'Created_At',                format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Line_Items_File_ID',        format: '@',                     validation: null },
      { header: 'Line_Items_SHA256',         format: '@',                     validation: null },
      { header: 'Supporting_Docs_Folder_ID', format: '@',                     validation: null },
      { header: 'FINDES_File_ID',            format: '@',                     validation: null },
      { header: 'FINDES_SHA256',             format: '@',                     validation: null },
      { header: 'CM_File_ID',                format: '@',                     validation: null },
      { header: 'CM_TRN',                    format: '@',                     validation: null },
      { header: 'Bank_TX_DateTime',          format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Annex_H_File_ID',           format: '@',                     validation: null },
      { header: 'Annex_H_Report_No',         format: '@',                     validation: null },
      { header: 'Handoff_Email_Sent_At',     format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Closed_At',                 format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Notes',                     format: null,                    validation: null },
    ],
    conditionalFormatting: [
      { whenFormula: '=$E2="Failed - Bank Mismatch"',             range: 'A2:Y', background: '#FCE8E6' },
      { whenFormula: '=$E2="Closed"',                              range: 'A2:Y', background: '#E6F4EA' },
      { whenFormula: '=$E2="Partially Released - Hold Pending"',  range: 'A2:Y', background: '#FEF7E0' },
    ],
  },

  // SCHEMA §2 — Held_Records_Open
  {
    name: 'Held_Records_Open',
    yearly: false,
    frozenRows: 1,
    frozenCols: 0,
    columns: [
      { header: 'Batch_No',              format: '@',                     validation: null },
      { header: 'Row_Index',             format: '0',                     validation: null },
      { header: 'HRIS_ID',               format: '@',                     validation: null },
      { header: 'HRIS_Name_Master',      format: null,                    validation: null },
      { header: 'Amount_PHP',            format: '#,##0.00',              validation: null },
      { header: 'Hold_Reason',           format: null,                    validation: null },
      { header: 'Held_At',               format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Held_By',               format: null,                    validation: null },
      { header: 'Status',                format: null,                    validation: { kind: 'list', values: HELD_RECORD_STATUSES } },
      { header: 'Released_In_Sub_Batch', format: '@',                     validation: null },
    ],
  },

  // SCHEMA §7 — Outbound_Email_Queue
  {
    name: 'Outbound_Email_Queue',
    yearly: false,
    frozenRows: 1,
    frozenCols: 0,
    columns: [
      { header: 'Queue_ID',        format: '@',                     validation: null },
      { header: 'Batch_No',        format: '@',                     validation: null },
      { header: 'Row_Index',       format: '0',                     validation: null },
      { header: 'Recipient_Email', format: null,                    validation: null },
      { header: 'Subject',         format: null,                    validation: null },
      { header: 'Body_HTML',       format: null,                    validation: null },
      { header: 'Status',          format: null,                    validation: { kind: 'list', values: OUTBOUND_EMAIL_QUEUE_STATUSES } },
      { header: 'Attempts',        format: '0',                     validation: null },
      { header: 'Last_Error',      format: null,                    validation: null },
      { header: 'Enqueued_At',     format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Sent_At',         format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
    ],
  },

  // SCHEMA §8 — HRIS_Pending_Changes
  {
    name: 'HRIS_Pending_Changes',
    yearly: false,
    frozenRows: 1,
    frozenCols: 0,
    columns: [
      { header: 'Request_ID',               format: '@',                     validation: null },
      { header: 'Requested_At',             format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Requested_By',             format: null,                    validation: null },
      { header: 'Action',                   format: null,                    validation: { kind: 'list', values: HRIS_PENDING_CHANGE_ACTIONS } },
      { header: 'HRIS_ID',                  format: '@',                     validation: null },
      { header: 'Before_JSON',              format: null,                    validation: null },
      { header: 'After_JSON',               format: null,                    validation: null },
      { header: 'Status',                   format: null,                    validation: { kind: 'list', values: HRIS_PENDING_CHANGE_STATUSES } },
      { header: 'Decision_At',              format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Decision_By',              format: null,                    validation: null },
      { header: 'Decision_Note',            format: null,                    validation: null },
      { header: 'Treasury_Bridge_Response', format: null,                    validation: null },
    ],
  },

  // SCHEMA §9 — Audit_Log_<YYYY>
  {
    name: 'Audit_Log_<YYYY>',
    yearly: true,
    frozenRows: 1,
    frozenCols: 0,
    protectWarningOnly: 'Append-only audit log. Write via Audit.gs only — never edit cells directly (SCHEMA §9).',
    columns: [
      { header: 'Event_ID',     format: '@',                     validation: null },
      { header: 'Timestamp',    format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Actor_Email',  format: null,                    validation: null },
      { header: 'Role',         format: null,                    validation: null },
      { header: 'Action',       format: null,                    validation: null },
      { header: 'Target_Type',  format: null,                    validation: null },
      { header: 'Target_Id',    format: '@',                     validation: null },
      { header: 'Before_JSON',  format: null,                    validation: null },
      { header: 'After_JSON',   format: null,                    validation: null },
      { header: 'Note',         format: null,                    validation: null },
      { header: 'Source_IP',    format: null,                    validation: null },
    ],
  },

  // SCHEMA §10 — _Setup_Log
  {
    name: '_Setup_Log',
    yearly: false,
    frozenRows: 1,
    frozenCols: 0,
    columns: [
      { header: 'Run_At',       format: 'yyyy-mm-dd HH:mm:ss',   validation: null },
      { header: 'Function',     format: null,                    validation: null },
      { header: 'Run_By',       format: null,                    validation: null },
      { header: 'Outcome',      format: null,                    validation: null },
      { header: 'Changes_JSON', format: null,                    validation: null },
      { header: 'Missing_JSON', format: null,                    validation: null },
      { header: 'Duration_Ms',  format: '0',                     validation: null },
      { header: 'Notes',        format: null,                    validation: null },
    ],
  },
];

/* =======================================================================
 * Apply spec to one sheet
 * ===================================================================== */

function _applySheetSpec(ss, spec, year, changes) {
  const name = _resolveName(spec.name, year);
  const ensured = _ensureSheet(ss, name);
  const sheet = ensured.sheet;
  if (ensured.created) changes.sheetsCreated.push(name);

  // Frozen rows / cols
  if (spec.frozenRows != null && sheet.getFrozenRows() !== spec.frozenRows) {
    sheet.setFrozenRows(spec.frozenRows);
  }
  if (spec.frozenCols != null && sheet.getFrozenColumns() !== spec.frozenCols) {
    sheet.setFrozenColumns(spec.frozenCols);
  }

  // Headers
  const headerAdds = _ensureHeaders(sheet, spec.columns);
  if (headerAdds.length > 0) {
    changes.columnsAdded[name] = headerAdds;
  }

  // Number formats + dropdown validations, applied per column by header lookup.
  // This runs every time (idempotent) — re-setting the same format / rule
  // is a no-op on Sheets' side.
  for (let i = 0; i < spec.columns.length; i++) {
    const col = spec.columns[i];
    const idx = _columnIndexByHeader(sheet, col.header);
    if (idx <= 0) continue;
    _applyColumnFormat(sheet, idx, col.format);
    _applyColumnValidation(sheet, idx, col.validation, ss);
  }

  // Conditional formatting
  if (spec.conditionalFormatting) {
    const cfAdded = _applyConditionalFormatting(sheet, spec.conditionalFormatting);
    if (cfAdded.length > 0) {
      changes.conditionalFormattingAdded.push({
        sheet: name,
        rules: cfAdded.map(function (r) { return r.whenFormula; }),
      });
    }
  }

  // Protection (warning-only for v1)
  if (spec.protectWarningOnly) {
    const added = _applyProtectionWarningOnly(sheet, spec.protectWarningOnly);
    if (added) changes.protectionsAdded.push(name);
  }

  // Seed
  if (typeof spec.seed === 'function') {
    const seedResult = spec.seed(sheet);
    if (seedResult && seedResult.seeded) {
      changes.seeded[name] = seedResult;
    }
  }
}

/* =======================================================================
 * Drive year/month skeleton (SCHEMA §C step 6)
 * ===================================================================== */

function _readConfigValue(ss, key) {
  const sheet = ss.getSheetByName('Config');
  if (!sheet) return '';
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === key) return String(data[i][1] || '').trim();
  }
  return '';
}

function _ensureDriveSkeleton(rootId, year) {
  const result = { rootId: rootId, yearFolderCreated: null, monthsCreated: [] };
  if (!rootId) {
    result.skipped = 'combenDriveRootFolderId is blank — set it in Config and re-run to create year/month folders.';
    return result;
  }
  let root;
  try {
    root = DriveApp.getFolderById(rootId);
  } catch (e) {
    result.error = 'Cannot open root folder ' + rootId + ': ' + e.message;
    return result;
  }

  const yearIter = root.getFoldersByName(year);
  let yearFolder;
  if (yearIter.hasNext()) {
    yearFolder = yearIter.next();
  } else {
    yearFolder = root.createFolder(year);
    result.yearFolderCreated = year;
  }

  const months = [
    '01-January', '02-February', '03-March',     '04-April',
    '05-May',     '06-June',     '07-July',      '08-August',
    '09-September','10-October', '11-November',  '12-December',
  ];
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    const iter = yearFolder.getFoldersByName(m);
    if (!iter.hasNext()) {
      yearFolder.createFolder(m);
      result.monthsCreated.push(m);
    }
  }
  return result;
}

/* =======================================================================
 * _Setup_Log writer
 * ===================================================================== */

function _writeSetupLog(ss, fnName, runBy, outcome, changesObj, missingObj, durationMs, notes) {
  const sheet = ss.getSheetByName('_Setup_Log');
  if (!sheet) {
    // _Setup_Log is created first thing in setupComBenSchema. If it's
    // missing here we are in a verify call against an unbootstrapped
    // spreadsheet — record nothing rather than crash the run.
    return;
  }
  sheet.appendRow([
    _now(),
    fnName,
    runBy,
    outcome,
    changesObj ? JSON.stringify(changesObj) : '',
    missingObj ? JSON.stringify(missingObj) : '',
    durationMs,
    notes || '',
  ]);
}

/* =======================================================================
 * Main entry points
 * ===================================================================== */

/**
 * Idempotent schema bootstrap. Safe to re-run.
 *
 * @param {string=} spreadsheetId  Optional. Defaults to the active spreadsheet.
 * @return {object}                Structured report { ok, outcome, changes, durationMs, notes }.
 */
function setupComBenSchema(spreadsheetId) {
  const t0 = Date.now();
  const ss = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('setupComBenSchema: no spreadsheet. Pass spreadsheetId or run from the bound Apps Script editor.');
  }
  const runBy = _activeEmail();
  const year = _currentYear();
  const changes = {
    sheetsCreated: [],
    columnsAdded: {},
    protectionsAdded: [],
    conditionalFormattingAdded: [],
    seeded: {},
    driveSkeleton: null,
  };
  const notes = [];

  // 1. Ensure _Setup_Log first so the rest of the run can be recorded.
  const setupLogSpec = SHEET_SPECS.find(function (s) { return s.name === '_Setup_Log'; });
  if (setupLogSpec) _applySheetSpec(ss, setupLogSpec, year, changes);

  // 2. Then walk every other sheet in spec order.
  for (let i = 0; i < SHEET_SPECS.length; i++) {
    const spec = SHEET_SPECS[i];
    if (spec.name === '_Setup_Log') continue;
    _applySheetSpec(ss, spec, year, changes);
  }

  // 3. Drive year/month skeleton (depends on Config being seeded above).
  const rootId = _readConfigValue(ss, 'combenDriveRootFolderId');
  const driveResult = _ensureDriveSkeleton(rootId, year);
  changes.driveSkeleton = driveResult;
  if (driveResult.skipped) notes.push(driveResult.skipped);
  if (driveResult.error)   notes.push(driveResult.error);

  const durationMs = Date.now() - t0;
  const anyChange =
    changes.sheetsCreated.length > 0 ||
    Object.keys(changes.columnsAdded).length > 0 ||
    changes.protectionsAdded.length > 0 ||
    changes.conditionalFormattingAdded.length > 0 ||
    Object.keys(changes.seeded).length > 0 ||
    !!driveResult.yearFolderCreated ||
    (driveResult.monthsCreated && driveResult.monthsCreated.length > 0);
  const outcome = anyChange ? 'OK_WITH_CHANGES' : 'OK';

  _writeSetupLog(ss, 'setupComBenSchema', runBy, outcome, changes, null, durationMs, notes.join(' | '));
  return { ok: true, outcome: outcome, changes: changes, durationMs: durationMs, notes: notes };
}

/**
 * Read-only health check. Reports missing sheets, missing columns,
 * wrong frozen-row/col counts, and missing protections.
 *
 * @param {string=} spreadsheetId
 * @return {object} { ok, outcome, missing, durationMs }
 */
function verifyComBenSchema(spreadsheetId) {
  const t0 = Date.now();
  const ss = spreadsheetId
    ? SpreadsheetApp.openById(spreadsheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('verifyComBenSchema: no spreadsheet.');
  }
  const runBy = _activeEmail();
  const year = _currentYear();
  const missing = {
    sheets: [],
    columns: {},
    frozenRows: [],
    frozenCols: [],
    protections: [],
  };

  for (let i = 0; i < SHEET_SPECS.length; i++) {
    const spec = SHEET_SPECS[i];
    const name = _resolveName(spec.name, year);
    const sheet = ss.getSheetByName(name);
    if (!sheet) {
      missing.sheets.push(name);
      continue;
    }
    if (spec.frozenRows != null && sheet.getFrozenRows() !== spec.frozenRows) {
      missing.frozenRows.push({ sheet: name, want: spec.frozenRows, got: sheet.getFrozenRows() });
    }
    if (spec.frozenCols != null && sheet.getFrozenColumns() !== spec.frozenCols) {
      missing.frozenCols.push({ sheet: name, want: spec.frozenCols, got: sheet.getFrozenColumns() });
    }
    const lastCol = sheet.getLastColumn();
    const currentHeaders = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
      : [];
    const presentSet = new Set(currentHeaders.filter(function (h) { return h !== ''; }));
    const missingCols = [];
    for (let j = 0; j < spec.columns.length; j++) {
      if (!presentSet.has(spec.columns[j].header)) missingCols.push(spec.columns[j].header);
    }
    if (missingCols.length > 0) missing.columns[name] = missingCols;
    if (spec.protectWarningOnly) {
      const prots = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
      if (!prots || prots.length === 0) missing.protections.push(name);
    }
  }

  const durationMs = Date.now() - t0;
  const allOk =
    missing.sheets.length === 0 &&
    Object.keys(missing.columns).length === 0 &&
    missing.frozenRows.length === 0 &&
    missing.frozenCols.length === 0 &&
    missing.protections.length === 0;
  const outcome = allOk ? 'OK' : 'FAILED';

  _writeSetupLog(ss, 'verifyComBenSchema', runBy, outcome, null, allOk ? null : missing, durationMs, '');
  return { ok: allOk, outcome: outcome, missing: missing, durationMs: durationMs };
}

/* =======================================================================
 * Spreadsheet menu wiring
 * ===================================================================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ComBen Admin')
    .addItem('Run setupComBenSchema', '_menuSetupSchema')
    .addItem('Run verifyComBenSchema', '_menuVerifySchema')
    .addSeparator()
    .addItem('Install notification trigger', '_menuInstallNotifTrigger')
    .addItem('Remove notification trigger', '_menuRemoveNotifTrigger')
    .addItem('Drain notification queue now', '_menuDrainNotifQueue')
    .addToUi();
}

function _menuSetupSchema() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert(
    'Run setupComBenSchema()?',
    'Creates or extends ComBen sheets per docs/SCHEMA.md. Idempotent — safe to re-run.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  try {
    const r = setupComBenSchema();
    const notes = (r.notes && r.notes.length) ? '\n\nNotes:\n' + r.notes.join('\n') : '';
    ui.alert(
      'setupComBenSchema',
      'Outcome: ' + r.outcome + '\nDuration: ' + r.durationMs + ' ms\n\nSee _Setup_Log for the full changes JSON.' + notes,
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('setupComBenSchema FAILED', e.message + '\n\n' + (e.stack || ''), ui.ButtonSet.OK);
    throw e;
  }
}

function _menuVerifySchema() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = verifyComBenSchema();
    const detail = r.outcome === 'OK'
      ? 'All sheets, columns, frozen panes, and protections present.'
      : JSON.stringify(r.missing, null, 2);
    ui.alert(
      'verifyComBenSchema',
      'Outcome: ' + r.outcome + '\nDuration: ' + r.durationMs + ' ms\n\n' + detail,
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('verifyComBenSchema FAILED', e.message + '\n\n' + (e.stack || ''), ui.ButtonSet.OK);
    throw e;
  }
}
