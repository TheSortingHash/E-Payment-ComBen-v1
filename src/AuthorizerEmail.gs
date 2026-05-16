/**
 * ComBen — Phase 4 authorizer endorsement email (SPEC §7.1).
 *
 * Sent automatically from batch_submit (Slice 5+6 wire-up) once the
 * FINDES has been generated and right before the state transition.
 * Failure here keeps the batch in Draft so the Maker can fix and
 * resubmit (e.g. add an authorizer to the Authorizers sheet).
 *
 * Recipients: every `Active = YES` row in the Authorizers sheet.
 * BCC: Config.adminEmail (if set).
 *
 * Attachments (NOT links — Drive permission friction):
 *   - PAYROLL_UPLOAD_<BatchNo>.xlsx renamed for clarity to
 *     "Payroll_Register_<BatchNo>.xlsx" in the email
 *   - All files in <batch>/supporting_docs/
 *
 * Deliberately NOT attached:
 *   - FINDES CSV — bank-side only, no review value for authorizers
 *   - Annex H — post-process (Phase 8), doesn't exist yet
 */

function _readActiveAuthorizers() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Authorizers');
  if (!sheet) throw new Error('Authorizers sheet missing — run setupComBenSchema()');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const out = [];
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][3] || '').toUpperCase() !== 'YES') continue;
    const email = String(data[i][1] || '').trim();
    if (!email) continue;
    out.push({
      name: String(data[i][0] || ''),
      email: email,
      title: String(data[i][2] || ''),
    });
  }
  return out;
}

function _collectAuthorizerAttachments(batchNo) {
  const folder = ensureBatchFolder(batchNo);
  const attachments = [];

  // Payroll Register (Maker's original upload, friendly-named for the email).
  const payrollName = 'PAYROLL_UPLOAD_' + batchNo + '.xlsx';
  const payrollIter = folder.getFilesByName(payrollName);
  if (payrollIter.hasNext()) {
    const blob = payrollIter.next().getBlob().copyBlob();
    blob.setName('Payroll_Register_' + batchNo + '.xlsx');
    attachments.push(blob);
  }

  // All supporting docs, preserving their original filenames so
  // authorizers can identify each one.
  const supportingIter = folder.getFoldersByName('supporting_docs');
  if (supportingIter.hasNext()) {
    const supportingFolder = supportingIter.next();
    const fileIter = supportingFolder.getFiles();
    while (fileIter.hasNext()) {
      attachments.push(fileIter.next().getBlob());
    }
  }

  return attachments;
}

function _composeAuthorizerBody(head, items) {
  const heldItems = [];
  let activeCount = 0;
  let totalReleased = 0;
  let totalHeld = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.status === 'ACTIVE') {
      activeCount++;
      totalReleased += Number(it.amount_php);
    } else if (it.status === 'HOLD') {
      heldItems.push(it);
      totalHeld += Number(it.amount_php);
    }
  }

  const detailRows = [
    { label: 'Batch No.',                value: head.Batch_No, highlight: true },
    { label: 'Payroll Type',             value: head.Payroll_Type },
    { label: 'Period Covered',           value: head.Period_Covered || '(not specified)' },
    { label: 'Records to Release',       value: String(activeCount) },
    { label: 'Total Amount to Release',  value: 'PHP ' + formatPhpAmount(totalReleased), highlight: true },
  ];
  if (heldItems.length > 0) {
    detailRows.push({
      label: 'Records on Hold',
      value: heldItems.length + ' (PHP ' + formatPhpAmount(totalHeld) + ')',
    });
  }

  const intro =
    '<p>Dear Authorizers,</p>' +
    '<p>The <b>Compensation &amp; Benefits Unit</b> is endorsing the following payroll batch for your review and approval:</p>';

  const actionNote =
    '<p style="margin-top:30px;">The <b>Payroll Register</b> and all <b>supporting documents</b> are attached to this email for your review.</p>' +
    '<p style="font-weight:bold;">If approved, please proceed to the Landbank <b>WeAccess</b> portal to authorize the e-payment for the ' +
    activeCount + ' active record' + (activeCount === 1 ? '' : 's') + ' listed above.</p>';

  const signoff =
    '<p style="margin-top:30px;">Thank you,</p>' +
    '<p><b>Compensation &amp; Benefits Unit</b></p>';

  const bodyHtml =
    intro +
    renderDetailsTable(detailRows) +
    renderHeldRecordsSection(heldItems) +
    actionNote +
    signoff;

  return renderDapEmailShell({
    title: 'Endorsement Request',
    bodyHtml: bodyHtml,
    footerNote:
      'This is an automated notification from the DAP ComBen E-Payment System. ' +
      'Approvals happen in the Landbank WeAccess portal — replies to this email reach the ComBen Unit, not the bank.',
  });
}

/**
 * Send the Phase 4 endorsement email. Caller is responsible for
 * lock acquisition (batch_submit wraps this call in withBatchLock).
 *
 * @param {string} batchNo
 * @param {object=} opts
 *   - session: {email, role} for the audit row; falls back to
 *     authWhoami() then 'SYSTEM'.
 * @return {object} { batch_no, recipients, attachment_count, held_count }
 */
function sendAuthorizerEmail(batchNo, opts) {
  if (!batchNo) throw new Error('sendAuthorizerEmail: batch_no required');

  const head = batchHeadRead(batchNo);
  if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');

  const items = lineItemsRead(batchNo).items;
  const authorizers = _readActiveAuthorizers();
  if (authorizers.length === 0) {
    throw new Error(
      'No active authorizers configured. Add at least one row with ' +
      'Active = YES in the Authorizers sheet before submitting a batch.'
    );
  }

  const adminEmail = _emailConfig('adminEmail', '');
  const senderName = _emailConfig('comBenSenderName', 'DAP ComBen E-Payment System');
  const replyTo = _emailConfig('comBenReplyTo', '');

  const subject = '[ComBen] Endorsement Request — ' + batchNo + ' (' + head.Payroll_Type + ')';
  const htmlBody = _composeAuthorizerBody(head, items);
  const attachments = _collectAuthorizerAttachments(batchNo);

  const emailOptions = {
    to: authorizers.map(function (a) { return a.email; }).join(','),
    subject: subject,
    htmlBody: htmlBody,
    name: senderName,
    attachments: attachments,
  };
  if (adminEmail) emailOptions.bcc = adminEmail;
  if (replyTo) emailOptions.replyTo = replyTo;

  MailApp.sendEmail(emailOptions);

  let session = (opts && opts.session) || null;
  if (!session) {
    try { session = authWhoami() || {}; } catch (_e) { session = {}; }
  }
  const heldCount = items.filter(function (it) { return it.status === 'HOLD'; }).length;
  audit({
    action: 'AUTHORIZER_EMAIL_SENT',
    actor: session.email || 'SYSTEM',
    role: session.role || 'SYSTEM',
    targetType: 'BATCH',
    targetId: batchNo,
    after: {
      recipients: authorizers.map(function (a) { return a.email; }),
      bcc: adminEmail || null,
      attachment_count: attachments.length,
      held_count: heldCount,
    },
  });

  return {
    batch_no: batchNo,
    recipients: authorizers.map(function (a) { return a.email; }),
    attachment_count: attachments.length,
    held_count: heldCount,
  };
}
