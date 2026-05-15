/**
 * ComBen — FINDES CSV generation (SPEC §10).
 *
 * Single source of truth for the Landbank-format payroll CSV.
 * Both the menu entry (future Slice 13/14) and the web app endpoint
 * findes_regenerate call generateFindes — there are no parallel
 * implementations. (Treasury has three drifted copies; ComBen does
 * not repeat this mistake.)
 *
 * Output path:
 *   <ComBenRoot>/<YYYY>/<MM-Month>/<BatchNo>/<BatchNo>.csv
 *
 * Filename = Batch_No = 8 chars (Landbank WeAccess upload limit per
 * SPEC §0.4). On regeneration, the existing file is renamed to
 * `<BatchNo>.bak-<YYYYMMDD-HHMMSS>.csv` before the new one is written;
 * .bak files are local-only and don't carry the 8-char constraint.
 *
 * Row format (LF newlines, no trailing newline per §10.8):
 *   "<10-digit account>","<cleaned name>",<integer centavos>
 *
 * Contract (SPEC §10):
 *   - One row per ACTIVE payee. HOLD rows excluded.
 *   - Duplicate HRIS_IDs in the same batch are a hard error (§10.5).
 *   - Account length ≤ 7 chars is a hard error (§10.4) via padAccount.
 *   - Payee name from Payee_Database master, not the upload file (§10.6).
 *   - If a FINDES file already exists in the batch folder, the
 *     previous one is renamed to FINDES_<BatchNo>.bak-<YYYYMMDD-HHMMSS>.csv
 *     before the new one is written (§10.9).
 */

/**
 * Generate the FINDES file for batchNo. Caller is responsible for
 * lock acquisition (batch_submit and findes_regenerate both wrap in
 * withBatchLock).
 *
 * @param {string} batchNo
 * @param {object=} opts
 *   - session: {email, role} to attribute the audit row to. Falls
 *     back to authWhoami() then 'SYSTEM' if not supplied.
 * @return {object} { batch_no, file_id, sha256, row_count, csv_size_bytes }
 */
function generateFindes(batchNo, opts) {
  if (!batchNo) throw new Error('generateFindes: batch_no required');

  const head = batchHeadRead(batchNo);
  if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');

  const items = lineItemsRead(batchNo).items;

  const seenHrisIds = new Set();
  const csvLines = [];
  let activeCount = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.status !== 'ACTIVE') continue;
    activeCount++;

    const ctx = 'HRIS_ID "' + it.hris_id + '" ("' + (it.hris_name_master || '') + '")';

    if (seenHrisIds.has(it.hris_id)) {
      throw new Error(
        'Duplicate HRIS_ID detected in batch ' + batchNo + ': ' + ctx + '. ' +
        'ComBen batches must be one payroll type with no duplicate payees. ' +
        'Please correct the roster before regenerating.'
      );
    }
    seenHrisIds.add(it.hris_id);

    // §10.4 — defensive re-pad. Line items already carry a padded
    // account (written by batch_create), but generateFindes owns this
    // check as the single source of truth.
    let acct;
    try {
      acct = padAccount(it.account_no, ctx);
    } catch (e) {
      throw new Error(
        'A valid bank account could not be found for ' + ctx + '. ' +
        'Please ensure this employee is enrolled in Payee_Database before regenerating. ' +
        '(' + e.message + ')'
      );
    }

    const cleanedName = cleanPayeeName(it.hris_name_master);
    if (!cleanedName) {
      throw new Error(
        'Cleaned payee name is empty for ' + ctx +
        '. Payee_Database master name is required for FINDES.'
      );
    }

    csvLines.push('"' + acct + '","' + cleanedName + '",' + formatCentavos(it.amount_php));
  }

  if (activeCount === 0) {
    throw new Error('generateFindes: batch ' + batchNo + ' has zero ACTIVE rows — nothing to write');
  }

  const csv = csvLines.join('\n');
  const sha = sha256Hex(csv);

  // §10.9 — idempotent save with .bak-<ts> rotation.
  const folder = ensureBatchFolder(batchNo);
  const filename = batchNo + '.csv';
  const existingIter = folder.getFilesByName(filename);
  if (existingIter.hasNext()) {
    const existing = existingIter.next();
    const ts = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
    existing.setName(batchNo + '.bak-' + ts + '.csv');
  }
  const file = folder.createFile(filename, csv, MimeType.CSV);

  batchHeadUpdate(batchNo, {
    FINDES_File_ID: file.getId(),
    FINDES_SHA256: sha,
  });

  let session = (opts && opts.session) || null;
  if (!session) {
    try { session = authWhoami() || {}; } catch (_e) { session = {}; }
  }
  audit({
    action: 'FINDES_GENERATED',
    actor: session.email || 'SYSTEM',
    role: session.role || 'SYSTEM',
    targetType: 'BATCH',
    targetId: batchNo,
    after: {
      file_id: file.getId(),
      sha256: sha,
      row_count: activeCount,
      csv_size_bytes: csv.length,
    },
  });

  return {
    batch_no: batchNo,
    file_id: file.getId(),
    sha256: sha,
    row_count: activeCount,
    csv_size_bytes: csv.length,
  };
}

/**
 * findes_regenerate — WEBAPP_ENDPOINTS §B.7.
 *
 * Allowed in Draft (before submit) and Pending Approval (after submit,
 * for corrections). Does not change Status. The existing file, if
 * any, is rotated to .bak-<ts> per §10.9.
 */
function findes_regenerate(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  const batchNo = args.batch_no;
  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
    if (head.Status !== 'Draft' && head.Status !== 'Pending Approval') {
      throw new Error(
        'STATE: findes_regenerate requires Draft or Pending Approval, got ' + head.Status
      );
    }
    return generateFindes(batchNo, { session: session });
  });
}
