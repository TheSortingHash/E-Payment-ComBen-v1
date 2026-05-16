/**
 * ComBen — Phase 1 & 2 endpoints (WEBAPP_ENDPOINTS §B.1–§B.6).
 *
 *   Phase 1 — batch_create
 *   Phase 2 — batch_get_review, row_hold / row_unhold / rows_hold_bulk,
 *             batch_submit
 *
 * batch_submit transitions Draft → Pending Approval and validates the
 * gate (errors-free, declared total matches). FINDES generation
 * (Slice 5) and authorizer email (Slice 6) are NOT yet wired — the
 * submit therefore moves state without producing the FINDES file or
 * sending the endorsement email. The audit row records this gap so
 * later slices can rebuild downstream effects from history if needed.
 *
 * Idempotency via client_request_id (WEBAPP_ENDPOINTS §A.5) is
 * deferred; retrying batch_create with the same args will throw
 * "STATE: batch already exists" once the head row is in place.
 */

const _BATCH_LETTER_PAIR_QUINCENA = ['AA', 'BA'];

function _findPayrollTypeByName(name) {
  for (let i = 0; i < PAYROLL_TYPES.length; i++) {
    if (PAYROLL_TYPES[i].name === name) return PAYROLL_TYPES[i];
  }
  return null;
}

/**
 * Suggest the next parent batch letter pair for (month, payroll-type-code)
 * in the given year sheet (SPEC §0.5). Parent batches always have
 * second letter 'A' — the first letter is what cycles. For PB/CS
 * Mode 2, only 'AA' (Q1) and 'BA' (Q2) are valid parents. For all
 * other (Mode 1) types, walks A, B, C, ... and returns the first
 * first-letter not already used as a parent for the (month, type).
 */
function _suggestBatchLetterPair(year, mm, payrollTypeCode) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Master_Payroll_Batches_' + year);
  if (!sheet) return 'AA';
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 'AA';
  const data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const usedFirstLetters = new Set();
  for (let i = 0; i < data.length; i++) {
    const bn = String(data[i][0]);
    const m = bn.match(/^(\d{2})([A-Z])([A-Z])([A-Z]{2})(\d{2})$/);
    if (!m) continue;
    if (m[1] !== mm) continue;
    if (m[4] !== payrollTypeCode) continue;
    // Only count parent batches (second letter 'A'); sub-batches
    // share their parent's first letter.
    if (m[3] === 'A') usedFirstLetters.add(m[2]);
  }
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    if (!usedFirstLetters.has(letter)) return letter + 'A';
  }
  return 'ZA';
}

/**
 * batch_create — Phase 1 entry. Parses the uploaded xlsx, validates
 * each row against Payee_Database, writes LINE_ITEMS JSON to Drive,
 * inserts the batch head row with Status = Draft.
 *
 * batch_create makes parent batches only (second letter of LL = 'A').
 * Hold-release sub-batches go through sub_batch_create (Slice 11).
 *
 * @param {object} args
 *   payroll_type:        string (name from PAYROLL_TYPES)
 *   period_covered:      string  (free text, e.g. "April 1-15, 2026")
 *   batch_letter_pair:   string  optional 2 uppercase letters; auto-
 *                                suggested if omitted. Must end in 'A'.
 *   year_yy:             string  optional 2-digit; defaults to current
 *   month_mm:            string  optional 2-digit; defaults to current
 *   payroll_file_id:     string  Drive file ID of the uploaded xlsx
 *   supporting_doc_ids:  string[] optional Drive file IDs
 * @return {object} { batch_no, line_items_count, active_count,
 *                    errors_count, computed_total, errors }
 */
function batch_create(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args) throw new Error('VALIDATION: missing args');

  const ptObj = _findPayrollTypeByName(args.payroll_type);
  if (!ptObj) throw new Error('VALIDATION: unknown payroll_type "' + args.payroll_type + '"');

  const now = new Date();
  const yy = args.year_yy || Utilities.formatDate(now, TZ, 'yy');
  const mm = args.month_mm || Utilities.formatDate(now, TZ, 'MM');
  if (!/^\d{2}$/.test(yy) || !/^\d{2}$/.test(mm)) {
    throw new Error('VALIDATION: year_yy and month_mm must be 2-digit strings');
  }
  const monthInt = parseInt(mm, 10);
  if (monthInt < 1 || monthInt > 12) throw new Error('VALIDATION: month_mm out of range');

  let letterPair = String(args.batch_letter_pair || '').toUpperCase();
  if (!letterPair) {
    letterPair = _suggestBatchLetterPair('20' + yy, mm, ptObj.code);
  } else if (!/^[A-Z]{2}$/.test(letterPair)) {
    throw new Error('VALIDATION: batch_letter_pair must be exactly two uppercase letters');
  }
  if (letterPair.charAt(1) !== 'A') {
    throw new Error(
      'VALIDATION: batch_create makes parent batches only (second letter must be "A"); ' +
      'got "' + letterPair + '". Use sub_batch_create for hold-release sub-batches.'
    );
  }
  if (ptObj.quincenaMode && _BATCH_LETTER_PAIR_QUINCENA.indexOf(letterPair) === -1) {
    throw new Error(
      'VALIDATION: ' + ptObj.name + ' is quincena-keyed (AA=1st, BA=2nd); got "' + letterPair + '"'
    );
  }

  const batchNo = mm + letterPair + ptObj.code + yy;

  if (!args.payroll_file_id) throw new Error('VALIDATION: payroll_file_id is required');

  const parsed = parseUploadXlsx(args.payroll_file_id);
  const lookup = payeeBulkLookup(parsed.rows.map(function (r) { return r.hrisIdRaw; }));

  const lineItems = [];
  const errors = parsed.errors.slice();
  let computedTotal = 0;

  parsed.rows.forEach(function (row) {
    if (!isValidHrisId(row.hrisIdRaw)) {
      errors.push({ lineNumber: row.lineNumber, reason: 'HRIS_ID "' + row.hrisIdRaw + '" is not a valid 6-digit ID' });
      return;
    }
    const padded = padHrisId(row.hrisIdRaw);
    const rec = lookup.get(padded);
    if (!rec || !rec.found) {
      errors.push({ lineNumber: row.lineNumber, reason: 'HRIS_ID ' + padded + ' not found in Payee_Database' });
      return;
    }
    let accountNo;
    try {
      accountNo = padAccount(rec.landbank_account, 'HRIS_ID ' + padded);
    } catch (e) {
      errors.push({ lineNumber: row.lineNumber, reason: e.message });
      return;
    }
    const nameFile = row.hrisName;
    const nameMaster = rec.payee_name;
    const nameMatch = nameFile.trim().toUpperCase() === nameMaster.trim().toUpperCase();

    lineItems.push({
      hris_id: padded,
      hris_name_file: nameFile,
      hris_name_master: nameMaster,
      name_match: nameMatch,
      amount_php: row.amount,
      account_no: accountNo,
      email: rec.email,
      is_active_email: rec.is_active_email,
      status: 'ACTIVE',
      hold_reason: null,
      released_in_sub_batch: null,
      bank_status: null,
      bank_confirmed_at: null,
      cm_trn: null,
      notification_sent_at: null,
      notification_status: null,
      row_notes: [],
    });
    computedTotal += row.amount;
  });

  return withBatchLock(batchNo, function () {
    if (batchHeadRead(batchNo)) {
      throw new Error('STATE: batch ' + batchNo + ' already exists');
    }
    const batchFolder = ensureBatchFolder(batchNo);
    const supportingFolder = ensureSupportingDocsFolder(batchNo);

    // Move the source xlsx into the batch folder and rename to the
    // canonical PAYROLL_UPLOAD_<BatchNo>.xlsx. The original ID is
    // preserved so any upstream references still resolve.
    const xlsxFile = DriveApp.getFileById(args.payroll_file_id);
    xlsxFile.setName('PAYROLL_UPLOAD_' + batchNo + '.xlsx');
    xlsxFile.moveTo(batchFolder);

    if (Array.isArray(args.supporting_doc_ids)) {
      args.supporting_doc_ids.forEach(function (id) {
        try { DriveApp.getFileById(id).moveTo(supportingFolder); }
        catch (_e) {}
      });
    }

    batchHeadInsert({
      Batch_No: batchNo,
      Parent_Batch_No: '',
      Payroll_Type: ptObj.name,
      Period_Covered: args.period_covered || '',
      Status: 'Draft',
      Active_Count: lineItems.length,
      Hold_Count: 0,
      Total_Released: computedTotal,
      Total_Held: 0,
      Uploader_Name: session.display_name || session.email,
      Uploader_Email: session.email,
      Created_At: _now(),
      Supporting_Docs_Folder_ID: supportingFolder.getId(),
      Notes: errors.length > 0
        ? errors.length + ' validation error(s) — see Phase 2 review'
        : '',
    });
    lineItemsWrite(batchNo, lineItems);

    audit({
      action: 'BATCH_CREATED',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      after: {
        payroll_type: ptObj.name,
        period_covered: args.period_covered,
        active_count: lineItems.length,
        errors_count: errors.length,
        computed_total: computedTotal,
      },
    });

    return {
      batch_no: batchNo,
      line_items_count: lineItems.length,
      active_count: lineItems.length,
      errors_count: errors.length,
      computed_total: computedTotal,
      errors: errors.slice(0, 50),
    };
  });
}

/**
 * batch_get_review — Phase 2 entry; also serves the M&E read-only
 * view post-submit (SPEC §13). Verifies SHA256 on every read.
 */
function batch_get_review(args) {
  requireRole(['Maker', 'Admin', 'Accounting']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no is required');
  const batchNo = args.batch_no;
  const head = batchHeadRead(batchNo);
  if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');

  const read = lineItemsRead(batchNo);
  const items = read.items;
  const ptObj = _findPayrollTypeByName(head.Payroll_Type);
  const holdAllowed = ptObj ? ptObj.holdAllowed : false;

  let computed = 0, activeCount = 0, holdCount = 0;
  items.forEach(function (it) {
    if (it.status === 'ACTIVE') {
      computed += Number(it.amount_php);
      activeCount++;
    } else if (it.status === 'HOLD') {
      holdCount++;
    }
  });

  return {
    batch: head,
    rows: items.map(function (it, idx) {
      return Object.assign({ row_index: idx }, it);
    }),
    summary: {
      total: items.length,
      active: activeCount,
      hold: holdCount,
      computed_total: computed,
    },
    ui_capabilities: {
      hold_allowed: holdAllowed && head.Status === 'Draft',
      submit_allowed: head.Status === 'Draft',
      cm_upload_allowed: head.Status === 'Bank Processing',
    },
  };
}

function row_hold(args) {
  if (!args || args.row_index == null || args.hold_reason == null) {
    throw new Error('VALIDATION: batch_no, row_index, hold_reason required');
  }
  return _doRowHold(args.batch_no, [{ row_index: args.row_index, hold_reason: args.hold_reason }]);
}

function rows_hold_bulk(args) {
  if (!args || !Array.isArray(args.rows)) {
    throw new Error('VALIDATION: rows array required');
  }
  return _doRowHold(args.batch_no, args.rows);
}

function _doRowHold(batchNo, rows) {
  const session = requireRole(['Maker', 'Admin']);
  if (!batchNo) throw new Error('VALIDATION: batch_no required');
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('VALIDATION: at least one row required');
  }
  rows.forEach(function (r) {
    if (r.row_index == null) throw new Error('VALIDATION: row_index required');
    if (!r.hold_reason || String(r.hold_reason).trim() === '') {
      throw new Error('VALIDATION: hold_reason required for row ' + r.row_index);
    }
  });

  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch not found');
    if (head.Status !== 'Draft') {
      throw new Error('STATE: row_hold requires Draft status, got ' + head.Status);
    }
    const ptObj = _findPayrollTypeByName(head.Payroll_Type);
    if (!ptObj || !ptObj.holdAllowed) {
      throw new Error('STATE: hold not allowed for payroll type ' + head.Payroll_Type);
    }
    const read = lineItemsRead(batchNo);
    const items = read.items;
    rows.forEach(function (r) {
      const row = items[r.row_index];
      if (!row) throw new Error('VALIDATION: row_index ' + r.row_index + ' out of range');
      if (row.status === 'HOLD') return; // idempotent
      row.status = 'HOLD';
      row.hold_reason = String(r.hold_reason).trim();
    });
    lineItemsWrite(batchNo, items);
    _refreshBatchCounts(batchNo, items);

    rows.forEach(function (r) {
      const row = items[r.row_index];
      _addToHeldOpen(batchNo, r.row_index, row, session.email);
      audit({
        action: 'ROW_HELD',
        actor: session.email,
        role: session.role,
        targetType: 'LINE_ITEM',
        targetId: batchNo + '#' + r.row_index,
        after: { status: 'HOLD', hold_reason: row.hold_reason },
      });
    });
    return { ok: true, held: rows.length };
  });
}

function row_unhold(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no || args.row_index == null) {
    throw new Error('VALIDATION: batch_no and row_index required');
  }
  const batchNo = args.batch_no;
  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch not found');
    if (head.Status !== 'Draft') {
      throw new Error('STATE: row_unhold requires Draft status, got ' + head.Status);
    }
    const read = lineItemsRead(batchNo);
    const items = read.items;
    const row = items[args.row_index];
    if (!row) throw new Error('VALIDATION: row_index out of range');
    if (row.status !== 'HOLD') throw new Error('STATE: row not on hold');
    const before = { status: row.status, hold_reason: row.hold_reason };
    row.status = 'ACTIVE';
    row.hold_reason = null;
    lineItemsWrite(batchNo, items);
    _refreshBatchCounts(batchNo, items);
    _removeFromHeldOpen(batchNo, args.row_index);
    audit({
      action: 'ROW_UNHELD',
      actor: session.email,
      role: session.role,
      targetType: 'LINE_ITEM',
      targetId: batchNo + '#' + args.row_index,
      before: before,
      after: { status: 'ACTIVE', hold_reason: null },
    });
    return { ok: true };
  });
}

/**
 * batch_submit — Draft → Pending Approval. Slice 4 scope: gate
 * validation + state transition only. FINDES generation (Slice 5)
 * and authorizer email (Slice 6) get wired in later commits.
 */
function batch_submit(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  if (args.declared_total_php == null) {
    throw new Error('VALIDATION: declared_total_php required to submit');
  }
  const declared = Number(args.declared_total_php);
  if (!isFinite(declared)) throw new Error('VALIDATION: declared_total_php must be numeric');

  const batchNo = args.batch_no;
  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch not found');
    if (head.Status !== 'Draft') {
      throw new Error('STATE: batch_submit requires Draft status, got ' + head.Status);
    }
    const read = lineItemsRead(batchNo);
    const items = read.items;

    let computed = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].status !== 'ACTIVE') continue;
      if (!items[i].account_no || !items[i].hris_id) {
        throw new Error(
          'STATE: row ' + i + ' is ACTIVE but missing account_no / hris_id ' +
          '— fix in Phase 2 review before submitting'
        );
      }
      computed += Number(items[i].amount_php);
    }
    // Half-centavo tolerance for float drift.
    if (Math.abs(declared - computed) > 0.005) {
      throw new Error(
        'VALIDATION: declared_total_php (' + declared.toFixed(2) +
        ') does not match computed sum (' + computed.toFixed(2) + ')'
      );
    }

    // Phase 3 — generate FINDES inside the same batch lock. If this
    // throws (duplicate HRIS, short account, etc.), state stays Draft
    // and the Maker can fix and re-submit.
    const findesResult = generateFindes(batchNo, { session: session });

    // Phase 4 — send authorizer endorsement email with the Payroll
    // Register + supporting docs attached. If this throws (no active
    // authorizers, MailApp quota, etc.) state stays Draft so the
    // Maker fixes and resubmits — FINDES rotation on retry handles
    // the duplicate-file case automatically (§10.9).
    const emailResult = sendAuthorizerEmail(batchNo, { session: session });

    batchHeadUpdate(batchNo, { Status: 'Pending Approval' });
    audit({
      action: 'BATCH_SUBMITTED',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      before: { Status: 'Draft' },
      after: {
        Status: 'Pending Approval',
        computed_total: computed,
        declared_total: declared,
        findes_file_id: findesResult.file_id,
        findes_row_count: findesResult.row_count,
        authorizer_recipients: emailResult.recipients,
        authorizer_attachment_count: emailResult.attachment_count,
      },
    });
    return {
      ok: true,
      batch_no: batchNo,
      status: 'Pending Approval',
      findes: findesResult,
      authorizer_email: emailResult,
    };
  });
}

/* ----------------------------------------------------------------------
 * Internal helpers
 * -------------------------------------------------------------------- */

function _refreshBatchCounts(batchNo, items) {
  let activeCount = 0, holdCount = 0, totalReleased = 0, totalHeld = 0;
  items.forEach(function (it) {
    if (it.status === 'ACTIVE') { activeCount++; totalReleased += Number(it.amount_php); }
    else if (it.status === 'HOLD') { holdCount++; totalHeld += Number(it.amount_php); }
  });
  batchHeadUpdate(batchNo, {
    Active_Count: activeCount,
    Hold_Count: holdCount,
    Total_Released: totalReleased,
    Total_Held: totalHeld,
  });
}

function _addToHeldOpen(batchNo, rowIndex, row, heldByEmail) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Held_Records_Open');
  if (!sheet) throw new Error('Held_Records_Open missing — run setupComBenSchema().');
  sheet.appendRow([
    batchNo,
    rowIndex,
    row.hris_id,
    row.hris_name_master,
    Number(row.amount_php),
    row.hold_reason,
    _now(),
    heldByEmail,
    'OPEN',
    '',
  ]);
}

function _removeFromHeldOpen(batchNo, rowIndex) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Held_Records_Open');
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = data.length - 1; i >= 0; i--) {
    if (String(data[i][0]) === batchNo && Number(data[i][1]) === Number(rowIndex)) {
      sheet.deleteRow(i + 2);
      return;
    }
  }
}
