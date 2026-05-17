/**
 * ComBen — Phase 7 payee notifications (SPEC §7.2; WEBAPP_ENDPOINTS §H.1).
 *
 * cm_confirm (Slice 7) enqueues one Outbound_Email_Queue row per
 * CONFIRMED payee with a real email, leaving Subject / Body_HTML
 * blank. This module renders and sends them.
 *
 *   trigger_drain_notification_queue  — time-driven, runs every minute
 *   installNotificationTrigger        — admin: create the 1/min trigger
 *   uninstallNotificationTrigger      — admin: remove it
 *
 * Sending: MailApp (matches the Treasury payee-email implementation
 * and Slice 6's authorizer email; needs only the script.send_mail
 * scope). The per-payroll-type Subject / Body templates live in the
 * Payroll_Types sheet (cols E/F) and are editable without code.
 * The rendered body is wrapped in the shared DAP email shell
 * (EmailTemplates.gs) so payee notifications carry the same DAP-logo
 * branding as the authorizer email.
 *
 * Robustness: each successful send marks its queue row Status=SENT
 * in place *before* the next send, so a mid-run crash never causes a
 * re-send of an already-delivered email. SENT rows are deleted at the
 * end of the run (and defensively at the start of the next).
 */

var _NOTIF_MAX_PER_RUN = 100; // hard cap regardless of config (execution-time safety)

/* ----------------------------------------------------------------------
 * Template rendering
 * -------------------------------------------------------------------- */

/** Replace every {{key}} in `template` with data[key]. */
function _renderTemplate(template, data) {
  let s = String(template == null ? '' : template);
  Object.keys(data).forEach(function (key) {
    const val = data[key] == null ? '' : String(data[key]);
    s = s.split('{{' + key + '}}').join(val);
  });
  return s;
}

/** Look up a Payroll_Types row by display name; falls back to the
 *  Constants.gs defaults if a template cell is blank. */
function _payrollTypeRow(typeName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payroll_Types');
  if (!sheet) throw new Error('Payroll_Types sheet missing — run setupComBenSchema()');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Payroll_Types is empty');
  const data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === typeName) {
      return {
        payrollType: data[i][0],
        code: data[i][1],
        notificationSubject: String(data[i][4] || '') || DEFAULT_NOTIFICATION_SUBJECT,
        notificationBodyHtml: String(data[i][5] || '') || DEFAULT_NOTIFICATION_BODY,
      };
    }
  }
  throw new Error('Payroll type "' + typeName + '" not found in Payroll_Types sheet');
}

/** Render the subject + full HTML body for one payee notification. */
function _renderPayeeEmail(head, item, ptRow) {
  const data = {
    payee_name: item.hris_name_master || '',
    payroll_type: head.Payroll_Type || '',
    period: head.Period_Covered || '',
    batch_no: head.Batch_No || '',
    amount: formatPhpAmount(item.amount_php),
    trn: item.cm_trn || head.CM_TRN || '',
    bank_tx_datetime: item.bank_confirmed_at || head.Bank_TX_DateTime || '',
    account_last4: String(item.account_no || '').slice(-4),
  };
  const subject = _renderTemplate(ptRow.notificationSubject, data);
  const innerBody = _renderTemplate(ptRow.notificationBodyHtml, data);
  const htmlBody = renderDapEmailShell({
    title: 'Payroll Credit Confirmation',
    bodyHtml: innerBody,
    footerNote: 'This is an automated notification from the DAP ComBen E-Payment System. ' +
                'Please verify the credit in your Landbank account.',
  });
  return { subject: subject, htmlBody: htmlBody };
}

/* ----------------------------------------------------------------------
 * Queue draining
 * -------------------------------------------------------------------- */

function _markQueueFailure(queueSheet, q, errorMsg) {
  const newAttempts = q.attempts + 1;
  queueSheet.getRange(q.sheetRow, 7).setValue(newAttempts >= 3 ? 'FAILED' : 'QUEUED');
  queueSheet.getRange(q.sheetRow, 8).setValue(newAttempts);
  queueSheet.getRange(q.sheetRow, 9).setValue(String(errorMsg).slice(0, 500));
}

function _deleteSentQueueRows(queueSheet) {
  const lastRow = queueSheet.getLastRow();
  if (lastRow < 2) return;
  const statuses = queueSheet.getRange(2, 7, lastRow - 1, 1).getValues();
  const toDelete = [];
  for (let i = 0; i < statuses.length; i++) {
    if (String(statuses[i][0]) === 'SENT') toDelete.push(i + 2);
  }
  toDelete.sort(function (a, b) { return b - a; });
  for (let i = 0; i < toDelete.length; i++) queueSheet.deleteRow(toDelete[i]);
}

/**
 * Transition any of `batchNos` that no longer have QUEUED rows from
 * Bank-Confirmed → Notifications Sent. FAILED rows do not block the
 * transition — they remain in the queue for Admin review so a bounced
 * email never stalls the whole batch.
 */
function _checkBatchesDrained(batchNos) {
  const queueSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Outbound_Email_Queue');
  const stillQueued = {};
  const lastRow = queueSheet.getLastRow();
  if (lastRow >= 2) {
    const data = queueSheet.getRange(2, 2, lastRow - 1, 6).getValues(); // cols B..G
    for (let i = 0; i < data.length; i++) {
      if (String(data[i][5]) === 'QUEUED') stillQueued[String(data[i][0])] = true;
    }
  }
  batchNos.forEach(function (batchNo) {
    if (stillQueued[batchNo]) return;
    const head = batchHeadRead(batchNo);
    if (!head || head.Status !== 'Bank-Confirmed') return;
    batchHeadUpdate(batchNo, { Status: 'Notifications Sent' });
    audit({
      action: 'BATCH_NOTIFICATIONS_DRAINED',
      actor: 'SYSTEM',
      role: 'SYSTEM',
      targetType: 'BATCH',
      targetId: batchNo,
      before: { Status: 'Bank-Confirmed' },
      after: { Status: 'Notifications Sent' },
    });
  });
}

/** Core drain logic — no locking (the trigger wrapper holds the lock). */
function _drainNotificationQueue() {
  const queueSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Outbound_Email_Queue');
  if (!queueSheet) return { processed: 0, sent: 0, failed: 0 };
  const lastRow = queueSheet.getLastRow();
  if (lastRow < 2) return { processed: 0, sent: 0, failed: 0 };

  let rate = parseInt(_emailConfig('notificationTriggerRate', '50'), 10) || 50;
  rate = Math.min(Math.max(rate, 1), _NOTIF_MAX_PER_RUN);

  const data = queueSheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const queued = [];
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][6]) !== 'QUEUED') continue;
    queued.push({
      sheetRow: i + 2,
      batchNo: String(data[i][1]),
      rowIndex: Number(data[i][2]),
      email: String(data[i][3]),
      attempts: Number(data[i][7]) || 0,
    });
    if (queued.length >= rate) break;
  }
  if (queued.length === 0) {
    _deleteSentQueueRows(queueSheet);
    return { processed: 0, sent: 0, failed: 0 };
  }

  const byBatch = {};
  queued.forEach(function (q) {
    (byBatch[q.batchNo] = byBatch[q.batchNo] || []).push(q);
  });

  const senderName = _emailConfig('comBenSenderName', 'DAP ComBen E-Payment System');
  const replyTo = _emailConfig('comBenReplyTo', '');
  let sentCount = 0, failedCount = 0;

  Object.keys(byBatch).forEach(function (batchNo) {
    const group = byBatch[batchNo];
    let head = null, items = null, ptRow = null, loadError = null;
    try {
      head = batchHeadRead(batchNo);
      if (!head) throw new Error('batch head not found');
      items = lineItemsRead(batchNo).items;
      ptRow = _payrollTypeRow(head.Payroll_Type);
    } catch (e) {
      loadError = String(e.message || e);
    }

    let dirty = false;
    for (let g = 0; g < group.length; g++) {
      const q = group[g];
      if (loadError) {
        _markQueueFailure(queueSheet, q, loadError);
        if (q.attempts + 1 >= 3) failedCount++;
        continue;
      }
      const item = items[q.rowIndex];
      try {
        if (!item) throw new Error('line item ' + q.rowIndex + ' missing');
        const rendered = _renderPayeeEmail(head, item, ptRow);
        const opts = {
          to: q.email,
          subject: rendered.subject,
          htmlBody: rendered.htmlBody,
          name: senderName,
        };
        if (replyTo) opts.replyTo = replyTo;
        MailApp.sendEmail(opts);
        // Mark SENT in place immediately — survives a mid-run crash.
        queueSheet.getRange(q.sheetRow, 7).setValue('SENT');
        queueSheet.getRange(q.sheetRow, 11).setValue(_now());
        item.notification_status = 'SENT';
        item.notification_sent_at = _now();
        dirty = true;
        sentCount++;
      } catch (e) {
        _markQueueFailure(queueSheet, q, String(e.message || e));
        if (q.attempts + 1 >= 3) {
          if (item) { item.notification_status = 'FAILED'; dirty = true; }
          failedCount++;
        }
      }
    }
    if (dirty && items) {
      // Queue is authoritative for send status; a JSON write failure
      // here only leaves the M&E display stale, so swallow it.
      try { lineItemsWrite(batchNo, items); } catch (_e) {}
    }
  });

  _deleteSentQueueRows(queueSheet);
  _checkBatchesDrained(Object.keys(byBatch));

  return { processed: queued.length, sent: sentCount, failed: failedCount };
}

/**
 * Time-driven entry point (WEBAPP_ENDPOINTS §H.1). Holds the script
 * lock so overlapping trigger runs — and concurrent batch endpoint
 * mutations — can't race the queue. Returns the drain summary, or
 * undefined when another run already holds the lock.
 */
function trigger_drain_notification_queue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return; // another run / endpoint active — skip this minute
  try {
    return _drainNotificationQueue();
  } finally {
    lock.releaseLock();
  }
}

/* ----------------------------------------------------------------------
 * Trigger management
 * -------------------------------------------------------------------- */

function installNotificationTrigger() {
  uninstallNotificationTrigger();
  ScriptApp.newTrigger('trigger_drain_notification_queue')
    .timeBased()
    .everyMinutes(1)
    .create();
  return { ok: true, intervalMinutes: 1 };
}

function uninstallNotificationTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'trigger_drain_notification_queue') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  return { ok: true, removed: removed };
}

/* ----------------------------------------------------------------------
 * Spreadsheet-menu wrappers (wired into onOpen in Schema.gs)
 * -------------------------------------------------------------------- */

function _menuInstallNotifTrigger() {
  const ui = SpreadsheetApp.getUi();
  try {
    installNotificationTrigger();
    ui.alert('Notification trigger',
      'Installed. The notification queue will now drain automatically every minute.',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Install failed', e.message, ui.ButtonSet.OK);
  }
}

function _menuRemoveNotifTrigger() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = uninstallNotificationTrigger();
    ui.alert('Notification trigger', 'Removed ' + r.removed + ' trigger(s).', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Remove failed', e.message, ui.ButtonSet.OK);
  }
}

function _menuDrainNotifQueue() {
  const ui = SpreadsheetApp.getUi();
  try {
    const r = trigger_drain_notification_queue();
    const msg = r
      ? ('Processed ' + r.processed + ' — sent ' + r.sent + ', failed ' + r.failed + '.')
      : 'A drain run is already in progress. Try again in a moment.';
    ui.alert('Notification queue', msg, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Drain failed', e.message, ui.ButtonSet.OK);
  }
}
