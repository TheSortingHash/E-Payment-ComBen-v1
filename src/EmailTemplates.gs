/**
 * ComBen — Email composition helpers (SPEC §7).
 *
 * Reusable DAP-palette HTML shell + chunk renderers. Used by:
 *   - AuthorizerEmail.gs (Slice 6) — Phase 4 endorsement email
 *   - Notifications.gs   (Slice 8) — Phase 7 payee notifications
 *
 * Style matches the Treasury web app exactly:
 *   - Navy #1C2790 header containing the DAP logo image
 *   - Gold #CDAE2C accent bar
 *   - Striped 2-column details table (#f2f2f2 alternating)
 *   - Gray footer (#f9f9f9) with automated-notification disclaimer
 *
 * The DAP logo URL plus a couple of branding bits are read from
 * Config (dapLogoUrl, comBenSenderName, comBenReplyTo) so branding
 * edits don't require a code change.
 */

function _emailConfig(key, fallback) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const v = _readConfigValue(ss, key);
  return v || fallback;
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a PHP amount with comma thousand-separators and 2 decimals.
 * Non-numeric / non-finite input returns '0.00'.
 */
function formatPhpAmount(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0.00';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Render the DAP-palette email shell. Returns a complete HTML
 * fragment ready to pass as `htmlBody`.
 *
 * @param {object} opts
 *   title:      uppercase header text (e.g. "ENDORSEMENT REQUEST")
 *   bodyHtml:   the main content HTML inserted between header and footer
 *   footerNote: short disclaimer text in the gray footer bar
 */
function renderDapEmailShell(opts) {
  const logoUrl = _emailConfig('dapLogoUrl', 'https://i.imgur.com/jaEbfAR.png');
  const title = String(opts && opts.title || '');
  const bodyHtml = String(opts && opts.bodyHtml || '');
  const footerNote = String(opts && opts.footerNote
    || 'This is an automated notification from the DAP ComBen E-Payment System.');

  return '' +
    '<div style="font-family:Arial,sans-serif;font-size:16px;color:#333;max-width:600px;margin:auto;border:1px solid #ddd;">' +
      '<div style="background-color:#1C2790;padding:20px;text-align:center;">' +
        '<img src="' + _esc(logoUrl) + '" alt="DAP Logo" style="width:400px;max-width:100%;">' +
      '</div>' +
      '<div style="padding:25px;border-top:5px solid #CDAE2C;">' +
        '<h2 style="color:#1C2790;text-align:center;font-size:24px;text-transform:uppercase;margin-top:0;">' +
          _esc(title) +
        '</h2>' +
        bodyHtml +
      '</div>' +
      '<div style="text-align:center;font-size:12px;color:#777;padding:15px;background-color:#f9f9f9;border-top:1px solid #ddd;">' +
        '<p style="margin:0;">' + _esc(footerNote) + '</p>' +
      '</div>' +
    '</div>';
}

/**
 * Render a striped 2-column details table. Rows with `highlight:true`
 * get the navy #1C2790 emphasis on the value cell, matching the
 * Treasury "Amount:" row style.
 *
 * @param {Array<{label:string, value:string, highlight?:boolean, html?:boolean}>} rows
 *   - html:true skips HTML escaping on the value (for pre-rendered inner HTML)
 */
function renderDetailsTable(rows) {
  const cells = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const bg = (i % 2 === 0) ? '#f2f2f2' : '#ffffff';
    const valueStyle = row.highlight
      ? 'padding:12px;border:1px solid #ddd;font-weight:bold;font-size:1.1em;color:#1C2790;'
      : 'padding:12px;border:1px solid #ddd;';
    const valueHtml = row.html ? String(row.value || '') : _esc(row.value);
    cells.push(
      '<tr style="background-color:' + bg + ';">' +
        '<td style="padding:12px;border:1px solid #ddd;font-weight:bold;">' + _esc(row.label) + '</td>' +
        '<td style="' + valueStyle + '">' + valueHtml + '</td>' +
      '</tr>'
    );
  }
  return '<table style="width:100%;border-collapse:collapse;margin-top:25px;margin-bottom:25px;">' +
    cells.join('') +
  '</table>';
}

/**
 * Render the "Records on Hold" yellow callout. Empty string if there
 * are no held items.
 *
 * @param {Array<{hris_id, hris_name_master, hold_reason}>} heldItems
 */
function renderHeldRecordsSection(heldItems) {
  if (!heldItems || heldItems.length === 0) return '';
  const lis = [];
  for (let i = 0; i < heldItems.length; i++) {
    const it = heldItems[i];
    lis.push(
      '<li><b>' + _esc(it.hris_name_master) + '</b> ' +
      '(HRIS ' + _esc(it.hris_id) + ') &mdash; ' +
      _esc(it.hold_reason || '(no reason given)') +
      '</li>'
    );
  }
  return '' +
    '<div style="margin-top:30px;padding:20px;background-color:#fef7e0;border-left:4px solid #CDAE2C;border-radius:5px;">' +
      '<h3 style="color:#1C2790;margin-top:0;">Records on Hold (' + heldItems.length + ')</h3>' +
      '<p style="margin-top:0;">The following payees are excluded from this release pending resolution:</p>' +
      '<ul style="line-height:1.6;margin:0;padding-left:20px;">' + lis.join('') + '</ul>' +
      '<p style="font-size:14px;color:#555;margin-bottom:0;margin-top:15px;">A sub-batch will be created for these records once the holds are cleared.</p>' +
    '</div>';
}
