/**
 * ComBen — Phase 6 Credit Memo cross-reference (SPEC §4; WEBAPP_ENDPOINTS §B.9-12).
 *
 *   cm_upload          — accept the CM xlsx, parse it, build the match
 *                        table, save the file. Does NOT change Status.
 *   cm_get_match_table — re-fetch the match table without re-uploading.
 *   cm_ack_exception   — acknowledge one exception with a justification.
 *   cm_confirm         — gate Phase 6 → 7: write bank_status into the
 *                        line items, populate the notification queue,
 *                        Status → Bank-Confirmed.
 *
 * Match algorithm (SPEC §4.2): ACTIVE line items vs CM rows, keyed on
 * the 10-char zero-padded account; amounts compared within a
 * half-centavo tolerance. HOLD rows are excluded from the cross-ref.
 *
 * Exception handling (SPEC §4.4): NOT_IN_CM and AMOUNT_MISMATCH are
 * blocking exceptions — each must be acknowledged (cm_ack_exception)
 * before cm_confirm will run. EXTRA_IN_CM (a CM row with no matching
 * batch payee) is surfaced in the summary as information but does not
 * block confirmation.
 */

/* ----------------------------------------------------------------------
 * Match core
 * -------------------------------------------------------------------- */

/**
 * Pure matcher — line items vs already-parsed CM data. No I/O.
 * @return {{trn, bank_tx_datetime, rows[], summary{}}}
 */
function _cmMatch(items, cmParsed) {
  const cmByAccount = new Map();
  for (let i = 0; i < cmParsed.rows.length; i++) {
    const key = normalizeAccount(cmParsed.rows[i].destinationAccount);
    if (!cmByAccount.has(key)) {
      cmByAccount.set(key, { cmRow: cmParsed.rows[i], used: false });
    }
  }

  const rows = [];
  let matched = 0, notInCm = 0, amountMismatches = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.status !== 'ACTIVE') continue;
    const acct = normalizeAccount(it.account_no);
    const hit = cmByAccount.get(acct);
    let match, cmAccount = null, cmAmount = null, cmDateTime = null;
    if (!hit) {
      match = 'NOT_IN_CM';
      notInCm++;
    } else {
      hit.used = true;
      cmAccount = hit.cmRow.destinationAccount;
      cmAmount = hit.cmRow.amountCredited;
      cmDateTime = hit.cmRow.txDateTime;
      if (cmAmount != null && Math.abs(Number(it.amount_php) - Number(cmAmount)) <= 0.005) {
        match = 'MATCHED';
        matched++;
      } else {
        match = 'AMOUNT_MISMATCH';
        amountMismatches++;
      }
    }
    rows.push({
      row_index: i,
      hris_id: it.hris_id,
      hris_name: it.hris_name_master,
      batch_account: acct,
      batch_amount: Number(it.amount_php),
      cm_account: cmAccount,
      cm_amount: cmAmount,
      cm_tx_datetime: cmDateTime,
      match: match,
      ack: it.cm_ack || null,
    });
  }

  let extraInCm = 0;
  cmByAccount.forEach(function (v) {
    if (v.used) return;
    extraInCm++;
    rows.push({
      row_index: null,
      hris_id: null,
      hris_name: null,
      batch_account: null,
      batch_amount: null,
      cm_account: v.cmRow.destinationAccount,
      cm_amount: v.cmRow.amountCredited,
      cm_tx_datetime: v.cmRow.txDateTime,
      match: 'EXTRA_IN_CM',
      ack: null,
    });
  });

  let bankDateTime = cmParsed.transactionDate || '';
  for (let i = 0; i < cmParsed.rows.length; i++) {
    if (cmParsed.rows[i].txDateTime) { bankDateTime = cmParsed.rows[i].txDateTime; break; }
  }

  return {
    trn: cmParsed.trn,
    bank_tx_datetime: bankDateTime,
    rows: rows,
    summary: {
      matched: matched,
      not_in_cm: notInCm,
      extra_in_cm: extraInCm,
      amount_mismatches: amountMismatches,
    },
  };
}

/** Re-parse the saved CM file and rebuild the match table. */
function _cmBuildMatchTable(batchNo) {
  const head = batchHeadRead(batchNo);
  if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
  if (!head.CM_File_ID) throw new Error('STATE: no Credit Memo uploaded for batch ' + batchNo);
  const items = lineItemsRead(batchNo).items;
  return _cmMatch(items, parseCMXlsx(head.CM_File_ID));
}

function _cmQueueNotifications(batchNo, items) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Outbound_Email_Queue');
  if (!sheet) throw new Error('Outbound_Email_Queue missing — run setupComBenSchema()');
  const now = _now();
  const newRows = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.bank_status !== 'CONFIRMED') continue;
    if (!it.is_active_email || !it.email) continue; // skip "inactive employee" sentinel
    newRows.push([
      Utilities.getUuid(), // Queue_ID
      batchNo,             // Batch_No
      i,                   // Row_Index
      it.email,            // Recipient_Email
      '',                  // Subject — rendered at send time (Slice 8)
      '',                  // Body_HTML — rendered at send time (Slice 8)
      'QUEUED',            // Status
      0,                   // Attempts
      '',                  // Last_Error
      now,                 // Enqueued_At
      '',                  // Sent_At
    ]);
  }
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, 11).setValues(newRows);
  }
  return newRows.length;
}

/** Admin alert when the CM cross-reference surfaces exceptions (SPEC §4.5, §7.4). */
function _cmEmailAdmin(batchNo, head, summary) {
  const adminEmail = _emailConfig('adminEmail', '');
  if (!adminEmail) return; // no admin configured — skip silently
  const detailRows = [
    { label: 'Batch No.', value: batchNo, highlight: true },
    { label: 'Payroll Type', value: head.Payroll_Type },
    { label: 'Not in Credit Memo', value: String(summary.not_in_cm) },
    { label: 'Amount Mismatches', value: String(summary.amount_mismatches) },
    { label: 'Extra in Credit Memo', value: String(summary.extra_in_cm) },
  ];
  const bodyHtml =
    '<p>The Credit Memo cross-reference for the batch below surfaced exceptions that need review:</p>' +
    renderDetailsTable(detailRows) +
    '<p>Open the batch in the ComBen dashboard to review the match table. Each NOT_IN_CM ' +
    'and AMOUNT_MISMATCH exception must be acknowledged with a justification before the ' +
    'batch can be confirmed.</p>';
  MailApp.sendEmail({
    to: adminEmail,
    subject: '[ComBen] CM Exceptions — ' + batchNo,
    htmlBody: renderDapEmailShell({
      title: 'Credit Memo Exceptions',
      bodyHtml: bodyHtml,
      footerNote: 'This is an automated alert from the DAP ComBen E-Payment System.',
    }),
    name: _emailConfig('comBenSenderName', 'DAP ComBen E-Payment System'),
  });
}

/* ----------------------------------------------------------------------
 * Endpoints
 * -------------------------------------------------------------------- */

/**
 * cm_upload — Phase 6 entry. Parses the CM xlsx, saves it to the batch
 * folder as CM_<BatchNo>_<TRN>.xlsx, records CM_File_ID / CM_TRN /
 * Bank_TX_DateTime on the head row, returns the match table. Does not
 * transition Status — confirmation happens in cm_confirm.
 */
function cm_upload(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  if (!args.cm_blob_id) throw new Error('VALIDATION: cm_blob_id required');
  const batchNo = args.batch_no;

  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
    if (head.Status !== 'Bank Processing') {
      throw new Error('STATE: cm_upload requires Bank Processing, got ' + head.Status);
    }

    const cmParsed = parseCMXlsx(args.cm_blob_id);
    if (!cmParsed.trn) {
      throw new Error(
        'VALIDATION: could not find the Transaction Reference Number in the CM file. ' +
        'Verify this is the Landbank Credit Memo for this batch.'
      );
    }

    const folder = ensureBatchFolder(batchNo);
    const cmFile = DriveApp.getFileById(args.cm_blob_id);
    cmFile.setName('CM_' + batchNo + '_' + cmParsed.trn + '.xlsx');
    cmFile.moveTo(folder);

    const items = lineItemsRead(batchNo).items;
    const matchTable = _cmMatch(items, cmParsed);

    batchHeadUpdate(batchNo, {
      CM_File_ID: cmFile.getId(),
      CM_TRN: cmParsed.trn,
      Bank_TX_DateTime: matchTable.bank_tx_datetime,
    });

    audit({
      action: 'CM_UPLOADED',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      after: {
        cm_file_id: cmFile.getId(),
        cm_trn: cmParsed.trn,
        summary: matchTable.summary,
      },
    });

    const exceptionCount = matchTable.summary.not_in_cm +
                           matchTable.summary.amount_mismatches +
                           matchTable.summary.extra_in_cm;
    if (exceptionCount > 0) {
      _cmEmailAdmin(batchNo, head, matchTable.summary);
    }

    return matchTable;
  });
}

/** cm_get_match_table — re-fetch the match table (WEBAPP_ENDPOINTS §B.10). */
function cm_get_match_table(args) {
  requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  const head = batchHeadRead(args.batch_no);
  if (!head) throw new Error('STATE: batch ' + args.batch_no + ' not found');
  if (head.Status !== 'Bank Processing') {
    throw new Error('STATE: cm_get_match_table requires Bank Processing, got ' + head.Status);
  }
  return _cmBuildMatchTable(args.batch_no);
}

/** cm_ack_exception — acknowledge one CM exception (WEBAPP_ENDPOINTS §B.11). */
function cm_ack_exception(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  if (args.row_index == null) throw new Error('VALIDATION: row_index required');
  if (!args.note || String(args.note).trim() === '') {
    throw new Error('VALIDATION: a justification note is required to acknowledge an exception');
  }
  const batchNo = args.batch_no;

  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
    if (head.Status !== 'Bank Processing') {
      throw new Error('STATE: cm_ack_exception requires Bank Processing, got ' + head.Status);
    }
    const items = lineItemsRead(batchNo).items;
    const row = items[args.row_index];
    if (!row) throw new Error('VALIDATION: row_index out of range');
    row.cm_ack = {
      at: _now(),
      by: session.email,
      note: String(args.note).trim(),
      match_kind: args.match_kind ? String(args.match_kind) : '',
    };
    lineItemsWrite(batchNo, items);
    audit({
      action: 'CM_EXCEPTION_ACKED',
      actor: session.email,
      role: session.role,
      targetType: 'LINE_ITEM',
      targetId: batchNo + '#' + args.row_index,
      after: { match_kind: row.cm_ack.match_kind, note: row.cm_ack.note },
    });
    return { ok: true };
  });
}

/**
 * cm_confirm — gate Phase 6 → 7 (WEBAPP_ENDPOINTS §B.12).
 *
 * Every NOT_IN_CM / AMOUNT_MISMATCH row must be acknowledged. Matched
 * rows become bank_status=CONFIRMED; everything else (NOT_IN_CM,
 * AMOUNT_MISMATCH) becomes NOT_PAID and is excluded from the
 * notification queue. Status → Bank-Confirmed.
 */
function cm_confirm(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  const batchNo = args.batch_no;

  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
    if (head.Status !== 'Bank Processing') {
      throw new Error('STATE: cm_confirm requires Bank Processing, got ' + head.Status);
    }

    const matchTable = _cmBuildMatchTable(batchNo);

    const unacked = matchTable.rows.filter(function (r) {
      return (r.match === 'NOT_IN_CM' || r.match === 'AMOUNT_MISMATCH') && !r.ack;
    });
    if (unacked.length > 0) {
      throw new Error(
        'STATE: ' + unacked.length + ' unresolved CM exception(s). Acknowledge each with a ' +
        'justification (cm_ack_exception) before confirming.'
      );
    }

    const resultByIndex = {};
    for (let i = 0; i < matchTable.rows.length; i++) {
      const r = matchTable.rows[i];
      if (r.row_index != null) resultByIndex[r.row_index] = r;
    }

    const items = lineItemsRead(batchNo).items;
    let confirmedCount = 0, notPaidCount = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.status !== 'ACTIVE') continue;
      const r = resultByIndex[i];
      it.cm_trn = matchTable.trn;
      if (r && r.match === 'MATCHED') {
        it.bank_status = 'CONFIRMED';
        it.bank_confirmed_at = r.cm_tx_datetime || matchTable.bank_tx_datetime || '';
        confirmedCount++;
      } else {
        it.bank_status = 'NOT_PAID';
        notPaidCount++;
      }
    }
    lineItemsWrite(batchNo, items);

    const queuedCount = _cmQueueNotifications(batchNo, items);
    batchHeadUpdate(batchNo, { Status: 'Bank-Confirmed' });

    audit({
      action: 'CM_CONFIRMED',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      before: { Status: 'Bank Processing' },
      after: {
        Status: 'Bank-Confirmed',
        confirmed: confirmedCount,
        not_paid: notPaidCount,
        cm_trn: matchTable.trn,
      },
    });
    audit({
      action: 'NOTIFICATION_QUEUED',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      after: { queued: queuedCount },
      note: 'Batch summary — one queue row per CONFIRMED payee with a real email; ' +
            'subject/body rendered at send time (Phase 7, Slice 8)',
    });

    return {
      ok: true,
      batch_no: batchNo,
      status: 'Bank-Confirmed',
      confirmed: confirmedCount,
      not_paid: notPaidCount,
      queued: queuedCount,
    };
  });
}
