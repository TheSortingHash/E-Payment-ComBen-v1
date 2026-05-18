/**
 * ComBen — Admin endpoints (WEBAPP_ENDPOINTS §D).
 *
 *   batch_cancel              — cancel a Draft / Pending Approval batch
 *   health_summary            — Admin health-panel figures
 *   audit_query               — filtered audit-log read
 *   health_heal_leading_zeros — rewrite leading-zero anomalies in
 *                               Payee_Database as padded text
 *
 * All are Admin-only. batch_cancel takes the per-batch lock;
 * health_heal_leading_zeros takes the Payee_Database lock.
 */

function _admin_parseTs(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * batch_cancel — WEBAPP_ENDPOINTS §D.5. Admin-only; allowed while the
 * batch is still Draft or Pending Approval (SPEC §1 — Cancelled is an
 * admin-only state requiring a reason).
 */
function batch_cancel(args) {
  const session = requireRole(['Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  if (!args.reason || String(args.reason).trim() === '') {
    throw new Error('VALIDATION: a cancellation reason is required');
  }
  const batchNo = args.batch_no;
  const reason = String(args.reason).trim();

  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
    if (head.Status !== 'Draft' && head.Status !== 'Pending Approval') {
      throw new Error('STATE: batch_cancel requires Draft or Pending Approval, got ' + head.Status);
    }
    batchHeadUpdate(batchNo, {
      Status: 'Cancelled',
      Notes: (head.Notes ? head.Notes + ' | ' : '') + 'Cancelled: ' + reason,
    });
    audit({
      action: 'BATCH_CANCELLED',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      before: { Status: head.Status },
      after: { Status: 'Cancelled' },
      note: reason,
    });
    return { ok: true, batch_no: batchNo, status: 'Cancelled' };
  });
}

/**
 * health_summary — WEBAPP_ENDPOINTS §D.3. Scans the operational
 * sheets for the figures the Admin health panel shows.
 */
function health_summary() {
  requireRole(['Admin']);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  // Leading-zero anomalies in Payee_Database.
  let acctAnom = 0, hrisAnom = 0;
  const payee = ss.getSheetByName('Payee_Database');
  if (payee && payee.getLastRow() >= 2) {
    const rows = payee.getRange(2, 1, payee.getLastRow() - 1, 4).getValues();
    for (let i = 0; i < rows.length; i++) {
      const acctRaw = rows[i][1], hrisRaw = rows[i][3];
      if (acctRaw != null && String(acctRaw).trim() !== '' &&
          String(acctRaw).trim() !== normalizeAccount(acctRaw)) acctAnom++;
      if (hrisRaw != null && String(hrisRaw).trim() !== '' &&
          String(hrisRaw).trim() !== padHrisId(hrisRaw)) hrisAnom++;
    }
  }

  // Notification queue depth + failed rows.
  let queueDepth = 0, failedNotifs = 0;
  const queue = ss.getSheetByName('Outbound_Email_Queue');
  if (queue && queue.getLastRow() >= 2) {
    const q = queue.getRange(2, 7, queue.getLastRow() - 1, 1).getValues(); // col G Status
    for (let i = 0; i < q.length; i++) {
      if (String(q[i][0]) === 'QUEUED') queueDepth++;
      else if (String(q[i][0]) === 'FAILED') failedNotifs++;
    }
  }

  // Open holds.
  let openHolds = 0;
  const held = ss.getSheetByName('Held_Records_Open');
  if (held && held.getLastRow() >= 2) {
    const h = held.getRange(2, 9, held.getLastRow() - 1, 1).getValues(); // col I Status
    for (let i = 0; i < h.length; i++) if (String(h[i][0]) === 'OPEN') openHolds++;
  }

  // Pending enrollment requests.
  let pendingEnroll = 0;
  const pend = ss.getSheetByName('HRIS_Pending_Changes');
  if (pend && pend.getLastRow() >= 2) {
    const p = pend.getRange(2, 8, pend.getLastRow() - 1, 1).getValues(); // col H Status
    for (let i = 0; i < p.length; i++) if (String(p[i][0]) === 'PENDING') pendingEnroll++;
  }

  // Integrity violations in the last 7 days.
  let integrityViol = 0;
  const auditSheet = ss.getSheetByName('Audit_Log_' + Utilities.formatDate(now, TZ, 'yyyy'));
  if (auditSheet && auditSheet.getLastRow() >= 2) {
    const a = auditSheet.getRange(2, 2, auditSheet.getLastRow() - 1, 4).getValues(); // B..E
    for (let i = 0; i < a.length; i++) {
      if (String(a[i][3]) !== 'INTEGRITY_VIOLATION') continue;
      const ts = _admin_parseTs(a[i][0]);
      if (ts && ts >= weekAgo) integrityViol++;
    }
  }

  return {
    leading_zero_anomalies: { landbank_account: acctAnom, hris_id: hrisAnom },
    queue_depth: queueDepth,
    failed_notifications: failedNotifs,
    integrity_violations_last_7_days: integrityViol,
    open_holds: openHolds,
    open_enrollment_requests: pendingEnroll,
  };
}

/**
 * audit_query — WEBAPP_ENDPOINTS §D.6. Filtered, newest-first read of
 * the audit log. All filters optional; capped at 200 rows by default.
 */
function audit_query(args) {
  requireRole(['Admin']);
  const a = args || {};
  const year = a.year ? String(a.year) : Utilities.formatDate(new Date(), TZ, 'yyyy');
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Audit_Log_' + year);
  if (!sheet || sheet.getLastRow() < 2) return { year: year, rows: [] };

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  const fromD = a.from ? _admin_parseTs(a.from) : null;
  const toD = a.to ? _admin_parseTs(a.to) : null;
  const wantActor = a.actor_email ? String(a.actor_email).toLowerCase() : '';
  const wantAction = a.action ? String(a.action) : '';
  const wantTarget = a.target_id ? String(a.target_id) : '';
  const limit = a.limit ? Math.min(Number(a.limit), 500) : 200;

  const out = [];
  for (let i = data.length - 1; i >= 0; i--) {
    const r = data[i];
    if (!r[0]) continue;
    if (wantActor && String(r[2]).toLowerCase() !== wantActor) continue;
    if (wantAction && String(r[4]) !== wantAction) continue;
    if (wantTarget && String(r[6]) !== wantTarget) continue;
    if (fromD || toD) {
      const ts = _admin_parseTs(r[1]);
      if (fromD && ts && ts < fromD) continue;
      if (toD && ts && ts > toD) continue;
    }
    out.push({
      event_id: r[0], timestamp: String(r[1]), actor: r[2], role: r[3],
      action: r[4], target_type: r[5], target_id: r[6], note: r[9],
    });
    if (out.length >= limit) break;
  }
  return { year: year, rows: out };
}

/**
 * health_heal_leading_zeros — WEBAPP_ENDPOINTS §D.4 (v1 form). Bulk
 * pass over Payee_Database: rewrites every account / HRIS cell whose
 * stored value differs from its padded form, and re-asserts the `@`
 * text format on both columns. Audited HEAL_LEADING_ZERO.
 *
 * (SPEC §D.4 describes a per-row heal via the Treasury bridge; with
 * the local mirror a single bulk pass is the practical equivalent.)
 */
function health_heal_leading_zeros() {
  const session = requireRole(['Admin']);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee_Database');
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: true, healed_accounts: 0, healed_hris: 0 };
  }
  return withPayeeDatabaseLock(function () {
    const lastRow = sheet.getLastRow();
    const rng = sheet.getRange(2, 1, lastRow - 1, 4);
    const data = rng.getValues();
    let healedAcct = 0, healedHris = 0;
    for (let i = 0; i < data.length; i++) {
      const acctRaw = data[i][1], hrisRaw = data[i][3];
      if (acctRaw != null && String(acctRaw).trim() !== '') {
        const padded = normalizeAccount(acctRaw);
        if (String(acctRaw).trim() !== padded) { data[i][1] = padded; healedAcct++; }
      }
      if (hrisRaw != null && String(hrisRaw).trim() !== '') {
        const padded = padHrisId(hrisRaw);
        if (String(hrisRaw).trim() !== padded) { data[i][3] = padded; healedHris++; }
      }
    }
    if (healedAcct > 0 || healedHris > 0) {
      sheet.getRange(2, 2, lastRow - 1, 1).setNumberFormat('@'); // Landbank Account
      sheet.getRange(2, 4, lastRow - 1, 1).setNumberFormat('@'); // HRIS Number
      rng.setValues(data);
      audit({
        action: 'HEAL_LEADING_ZERO',
        actor: session.email,
        role: session.role,
        targetType: 'PAYEE',
        targetId: 'Payee_Database',
        after: { healed_accounts: healedAcct, healed_hris: healedHris },
      });
    }
    return { ok: true, healed_accounts: healedAcct, healed_hris: healedHris };
  });
}
