/**
 * ComBen — Phase 5 WeAccess upload acknowledgment (WEBAPP_ENDPOINTS §B.8).
 *
 * Phase 5 is external: the Maker uploads the FINDES CSV to Landbank's
 * WeAccess portal and the Authorizers approve it there. This endpoint
 * only records that the upload happened, moving the batch from
 * Pending Approval → Bank Processing so it can later accept a Credit
 * Memo (Phase 6).
 */
function weaccess_mark_uploaded(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  const batchNo = args.batch_no;

  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
    if (head.Status !== 'Pending Approval') {
      throw new Error('STATE: weaccess_mark_uploaded requires Pending Approval, got ' + head.Status);
    }
    batchHeadUpdate(batchNo, { Status: 'Bank Processing' });
    audit({
      action: 'WEACCESS_UPLOADED',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      before: { Status: 'Pending Approval' },
      after: { Status: 'Bank Processing' },
      note: args.weaccess_note ? String(args.weaccess_note) : '',
    });
    return { ok: true, batch_no: batchNo, status: 'Bank Processing' };
  });
}
