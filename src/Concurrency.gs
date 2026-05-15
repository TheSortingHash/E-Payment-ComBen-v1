/**
 * ComBen — LockService wrappers (SPEC §2.5, §14.5, WEBAPP_ENDPOINTS §I).
 *
 * Apps Script exposes only one script-wide lock, so per-key locking is
 * coarse: every wrapper below ultimately serializes against the same
 * underlying lock. The label argument (batchNo / 'payee_db' / counter
 * key) is for diagnostics and to keep call sites self-documenting. If
 * contention becomes a problem, swap an individual wrapper for a
 * sentinel-cell CAS pattern on the relevant sheet.
 */

const DEFAULT_LOCK_TIMEOUT_MS = 30000;

function _withScriptLock(label, timeoutMs, fn) {
  const lock = LockService.getScriptLock();
  const tmo = timeoutMs || DEFAULT_LOCK_TIMEOUT_MS;
  if (!lock.tryLock(tmo)) {
    throw new Error('Could not acquire script lock (' + label + ') within ' + tmo + 'ms');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function withBatchLock(batchNo, fn, opts) {
  return _withScriptLock('batch:' + batchNo, opts && opts.timeoutMs, fn);
}

function withPayeeDatabaseLock(fn, opts) {
  return _withScriptLock('payee_db', opts && opts.timeoutMs, fn);
}

function withCounterLock(counterKey, fn, opts) {
  return _withScriptLock('counter:' + counterKey, opts && opts.timeoutMs, fn);
}
