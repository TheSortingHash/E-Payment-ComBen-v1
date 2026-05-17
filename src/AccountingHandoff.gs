/**
 * ComBen — Phase 9 accounting handoff (SPEC §1, §7.3; WEBAPP_ENDPOINTS §B.14, §B.16).
 *
 *   accounting_handoff         — email the liquidation package to the
 *                                Accounting recipients; Status
 *                                Annex H Generated → Forwarded to Accounting.
 *   accounting_confirm_receipt — Accounting / Admin records receipt;
 *                                Status Forwarded to Accounting → Closed.
 *
 * Attachments, not links — consistent with the Slice 6 authorizer-email
 * decision (Drive links create per-file permission friction). The
 * package is the Payroll Register, FINDES CSV, Credit Memo, Annex H
 * PDF, the held-records report (if one exists), and every
 * supporting-doc PDF. A pre-send size guard rejects packages over the
 * mail ceiling with a clear, actionable error.
 */

var _HANDOFF_MAX_ATTACH_BYTES = 23 * 1024 * 1024; // ~23 MB, under Gmail's 25 MB limit

/** Collect the batch's liquidation files (SPEC §7.3 order). */
function _handoffCollectFiles(batchNo, head) {
  const folder = ensureBatchFolder(batchNo);
  const files = [];
  const seen = {};

  function pushFile(f) {
    if (f && !seen[f.getId()]) { seen[f.getId()] = true; files.push(f); }
  }
  function addByName(name) {
    const it = folder.getFilesByName(name);
    if (it.hasNext()) pushFile(it.next());
  }
  function addById(id) {
    if (!id) return;
    try { pushFile(DriveApp.getFileById(id)); } catch (_e) {}
  }

  addByName('PAYROLL_UPLOAD_' + batchNo + '.xlsx'); // Payroll Register
  addByName(batchNo + '.csv');                      // FINDES
  addById(head.CM_File_ID);                         // Credit Memo
  addById(head.Annex_H_File_ID);                    // Annex H
  addByName('Held_Records_Report_' + batchNo + '.pdf'); // optional — present only if generated

  const subIt = folder.getFoldersByName('supporting_docs');
  if (subIt.hasNext()) {
    const fileIt = subIt.next().getFiles();
    while (fileIt.hasNext()) pushFile(fileIt.next());
  }
  return files;
}

/**
 * accounting_handoff — Phase 9 (WEBAPP_ENDPOINTS §B.14).
 *
 * Precondition Status = Annex H Generated. A send failure keeps the
 * batch in Annex H Generated for retry.
 */
function accounting_handoff(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  const batchNo = args.batch_no;

  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
    if (head.Status !== 'Annex H Generated') {
      throw new Error('STATE: accounting_handoff requires Annex H Generated, got ' + head.Status);
    }

    const recipients = String(_emailConfig('accountingRecipients', ''))
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
    if (recipients.length === 0) {
      throw new Error('No accountingRecipients configured in Config — set it before handing off.');
    }

    const items = lineItemsRead(batchNo).items;
    let paidCount = 0, paidTotal = 0, heldCount = 0, heldTotal = 0, notPaidCount = 0;
    items.forEach(function (it) {
      if (it.status === 'HOLD') {
        heldCount++;
        heldTotal += Number(it.amount_php);
      } else if (it.bank_status === 'CONFIRMED') {
        paidCount++;
        paidTotal += Number(it.amount_php);
      } else if (it.bank_status === 'NOT_PAID') {
        notPaidCount++;
      }
    });

    const files = _handoffCollectFiles(batchNo, head);
    let totalBytes = 0;
    files.forEach(function (f) { totalBytes += f.getSize(); });
    if (totalBytes > _HANDOFF_MAX_ATTACH_BYTES) {
      throw new Error(
        'VALIDATION: batch ' + batchNo + ' liquidation files total ' +
        (totalBytes / 1024 / 1024).toFixed(1) + ' MB, over the ~23 MB email limit. ' +
        'Hand the files over via shared Drive access instead.'
      );
    }
    const attachments = files.map(function (f) { return f.getBlob(); });

    const detailRows = [
      { label: 'Batch No.',          value: head.Batch_No, highlight: true },
      { label: 'Payroll Type',       value: head.Payroll_Type },
      { label: 'Period Covered',     value: head.Period_Covered || '(not specified)' },
      { label: 'Bank TRN',           value: head.CM_TRN || '(not recorded)' },
      { label: 'Transaction Date',   value: head.Bank_TX_DateTime || '(not recorded)' },
      { label: 'Annex H Report No.', value: head.Annex_H_Report_No || '(not recorded)' },
      { label: 'Records Paid',       value: String(paidCount) },
      { label: 'Total Disbursed',    value: 'PHP ' + formatPhpAmount(paidTotal), highlight: true },
    ];
    if (heldCount > 0) {
      detailRows.push({
        label: 'Records on Hold',
        value: heldCount + ' (PHP ' + formatPhpAmount(heldTotal) + ')',
      });
    }
    if (notPaidCount > 0) {
      detailRows.push({
        label: 'Records Not Paid',
        value: notPaidCount + ' (see Credit Memo cross-reference)',
      });
    }

    const fileListItems = files.map(function (f) {
      return '<li>' + _esc(f.getName()) + '</li>';
    }).join('');

    const bodyHtml =
      '<p>Dear Accounting Team,</p>' +
      '<p>The following payroll batch has been disbursed and is hereby ' +
      '<b>turned over for liquidation</b>:</p>' +
      renderDetailsTable(detailRows) +
      '<p style="margin-top:25px;"><b>Attached for liquidation:</b></p>' +
      '<ul style="line-height:1.6;">' + fileListItems + '</ul>' +
      '<p style="margin-top:25px;font-weight:bold;">This batch is forwarded for ' +
      'liquidation. Please confirm receipt.</p>' +
      '<p style="margin-top:30px;">Thank you,</p>' +
      '<p><b>Compensation &amp; Benefits Unit</b></p>';

    const opts = {
      to: recipients.join(','),
      subject: '[ComBen] Payroll Disbursement Turned Over for Liquidation — ' + batchNo,
      htmlBody: renderDapEmailShell({
        title: 'Payroll Disbursement — Turned Over for Liquidation',
        bodyHtml: bodyHtml,
        footerNote: 'This is an automated notification from the DAP ComBen E-Payment System.',
      }),
      name: _emailConfig('comBenSenderName', 'DAP ComBen E-Payment System'),
      attachments: attachments,
    };
    const replyTo = _emailConfig('comBenReplyTo', '');
    if (replyTo) opts.replyTo = replyTo;
    const adminEmail = _emailConfig('adminEmail', '');
    if (adminEmail) opts.bcc = adminEmail;

    MailApp.sendEmail(opts);

    const sentAt = _now();
    batchHeadUpdate(batchNo, {
      Status: 'Forwarded to Accounting',
      Handoff_Email_Sent_At: sentAt,
    });
    audit({
      action: 'ACCOUNTING_HANDOFF_SENT',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      before: { Status: 'Annex H Generated' },
      after: {
        Status: 'Forwarded to Accounting',
        recipients: recipients,
        attachment_count: attachments.length,
        records_paid: paidCount,
        total_disbursed: paidTotal,
      },
    });

    return {
      ok: true,
      batch_no: batchNo,
      status: 'Forwarded to Accounting',
      recipients: recipients,
      attachment_count: attachments.length,
      handoff_email_sent_at: sentAt,
    };
  });
}

/**
 * accounting_confirm_receipt — WEBAPP_ENDPOINTS §B.16.
 *
 * Accounting (or Admin) records receipt of the handoff package; the
 * batch reaches its terminal state. Implements the SPEC §1 Phase 9
 * "manual ack ... status → Closed" step.
 */
function accounting_confirm_receipt(args) {
  const session = requireRole(['Accounting', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  const batchNo = args.batch_no;

  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
    if (head.Status !== 'Forwarded to Accounting') {
      throw new Error('STATE: accounting_confirm_receipt requires Forwarded to Accounting, got ' + head.Status);
    }
    const closedAt = _now();
    batchHeadUpdate(batchNo, { Status: 'Closed', Closed_At: closedAt });
    audit({
      action: 'BATCH_CLOSED',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      before: { Status: 'Forwarded to Accounting' },
      after: { Status: 'Closed' },
      note: args.note ? String(args.note) : '',
    });
    return { ok: true, batch_no: batchNo, status: 'Closed', closed_at: closedAt };
  });
}
