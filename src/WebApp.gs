/**
 * ComBen — Web app shell (WEBAPP_ENDPOINTS §F.3).
 *
 * doGet serves the single-page app (index.html). The page drives every
 * workflow action through google.script.run against the endpoints in
 * Batch.gs / Findes.gs / Weaccess.gs / CM.gs / AnnexH.gs /
 * AccountingHandoff.gs / Auth.gs.
 *
 * Three UI-support endpoints live here:
 *   web_bootstrap    — session + payroll-type list + current yy/mm,
 *                      fetched once when the page loads
 *   batch_list       — dashboard batch listing for a year
 *   upload_temp_file — receive a base64 file from the browser, stage
 *                      it on Drive, return its file ID so batch_create
 *                      / cm_upload can consume it
 *
 * Note: endpoints return their raw result objects and throw on error;
 * the SPA's call() helper resolves the result or surfaces the thrown
 * message via withFailureHandler. Retrofitting the WEBAPP_ENDPOINTS
 * §A.2 { ok, data, error, audit_event_id } envelope across all
 * endpoints is deferred — the throw/resolve contract is sufficient
 * for the client.
 */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('DAP ComBen E-Payment')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Startup payload for the SPA. Returns session=null when not logged in. */
function web_bootstrap() {
  let session = null;
  try { session = authWhoami(); } catch (_e) { session = null; }
  const now = new Date();
  return {
    session: session,
    payroll_types: PAYROLL_TYPES.map(function (p) {
      return {
        name: p.name,
        code: p.code,
        quincena: p.quincenaMode,
        hold_allowed: p.holdAllowed,
      };
    }),
    current_yy: Utilities.formatDate(now, TZ, 'yy'),
    current_mm: Utilities.formatDate(now, TZ, 'MM'),
  };
}

/** Dashboard batch listing for a year (default current year), newest first. */
function batch_list(args) {
  requireRole(['Maker', 'Admin', 'Accounting']);
  const year = (args && args.year)
    ? String(args.year)
    : Utilities.formatDate(new Date(), TZ, 'yyyy');
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName('Master_Payroll_Batches_' + year);
  if (!sheet) return { year: year, batches: [] };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { year: year, batches: [] };
  const data = sheet.getRange(2, 1, lastRow - 1, 25).getValues();
  const batches = [];
  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    if (!r[0]) continue;
    batches.push({
      batch_no: String(r[0]),
      parent_batch_no: String(r[1] || ''),
      payroll_type: String(r[2] || ''),
      period_covered: String(r[3] || ''),
      status: String(r[4] || ''),
      active_count: r[5],
      hold_count: r[6],
      total_released: r[7],
      total_held: r[8],
      uploader_name: String(r[9] || ''),
      created_at: String(r[11] || ''),
    });
  }
  batches.reverse();
  return { year: year, batches: batches };
}

/**
 * Stage a browser-uploaded file on Drive. batch_create / cm_upload
 * move it into the batch folder afterward, so it lands in My Drive
 * root only transiently.
 */
function upload_temp_file(args) {
  requireRole(['Maker', 'Admin']);
  if (!args || !args.b64 || !args.name) {
    throw new Error('VALIDATION: name and b64 required');
  }
  const blob = Utilities.newBlob(
    Utilities.base64Decode(args.b64),
    args.mime || 'application/octet-stream',
    args.name
  );
  const file = DriveApp.createFile(blob);
  return { file_id: file.getId(), name: file.getName() };
}
