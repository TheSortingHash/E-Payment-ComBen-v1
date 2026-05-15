/**
 * ComBen — Audit log writer (SCHEMA §9, §B; WEBAPP_ENDPOINTS §A.4).
 *
 * Every mutating endpoint calls audit(...) once after success. The
 * returned event_id is included in the response envelope as
 * `audit_event_id`.
 *
 * Action names are validated against CANONICAL_AUDIT_ACTIONS at
 * runtime so typos fail loud. If you need a new action, add it to
 * Constants.gs AND to SCHEMA.md §B in the same commit.
 */

function audit(params) {
  if (!params || !params.action) {
    throw new Error('audit: action is required');
  }
  if (CANONICAL_AUDIT_ACTIONS.indexOf(params.action) === -1) {
    throw new Error(
      'audit: unknown action "' + params.action + '". ' +
      'Add it to Constants.gs CANONICAL_AUDIT_ACTIONS and SCHEMA.md §B first.'
    );
  }

  const ss = params.spreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  const year = Utilities.formatDate(new Date(), TZ, 'yyyy');
  const sheetName = 'Audit_Log_' + year;
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('audit: ' + sheetName + ' missing — run setupComBenSchema().');
  }

  const eventId = Utilities.getUuid();
  sheet.appendRow([
    eventId,
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    params.actor    || 'SYSTEM',
    params.role     || 'SYSTEM',
    params.action,
    params.targetType || '',
    params.targetId == null ? '' : String(params.targetId),
    params.before   == null ? '' : JSON.stringify(params.before),
    params.after    == null ? '' : JSON.stringify(params.after),
    params.note     || '',
    params.sourceIp || '',
  ]);
  return eventId;
}
