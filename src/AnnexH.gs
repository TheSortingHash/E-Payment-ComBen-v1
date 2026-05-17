/**
 * ComBen — Phase 8 Annex H generation (SPEC §16; WEBAPP_ENDPOINTS §B.13).
 *
 * Produces the COA "Daily Report of E-Payments from Agency Account
 * (Annex H of COA Circular 2021-014)" PDF for a batch's
 * bank-confirmed records.
 *
 * Build approach (OPEN_ITEMS build-phase decisions, resolved):
 *   - Output engine: a temporary Google Sheet is built programmatically
 *     and exported to PDF (SPEC §16.5 leans "Sheet"). No pre-uploaded
 *     template file to configure.
 *   - Payee name casing: mixed-case raw Payee Name (SPEC §16.3).
 *   - Pagination: ANNEX_H_ROWS_PER_PAGE rows per page; each page is a
 *     separate sheet in the temp spreadsheet, so the exported PDF is
 *     naturally multi-page. Final page carries the certification block.
 *
 * Report No. (`<YYYY>-<MM>-<NNN>`) is a per-month counter held in
 * Script Properties, incremented atomically inside the batch lock.
 */

var ANNEX_H_ROWS_PER_PAGE = 25;
var ANNEX_H_NUMCOLS = 9;

/* ----------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------- */

/** Parse a Bank_TX_DateTime value into { iso, yyyymm }. Tolerates
 *  "yyyy-MM-dd HH:mm:ss" and "MM/DD/YYYY ..."; falls back to today. */
function _annexHParseDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { iso: m[1] + '-' + m[2] + '-' + m[3], yyyymm: m[1] + '-' + m[2] };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mm = ('0' + m[1]).slice(-2);
    const dd = ('0' + m[2]).slice(-2);
    return { iso: m[3] + '-' + mm + '-' + dd, yyyymm: m[3] + '-' + mm };
  }
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return { iso: today, yyyymm: today.slice(0, 7) };
}

/** Reserve the next Report No. for a month. Called inside the batch
 *  lock, so the read-increment-write is atomic. Gaps (if generation
 *  fails after reserving) are acceptable for COA report numbers. */
function _annexHReserveReportNo(yyyymm) {
  const props = PropertiesService.getScriptProperties();
  const key = 'annexH_counter_' + yyyymm;
  const next = (parseInt(props.getProperty(key) || '0', 10) || 0) + 1;
  props.setProperty(key, String(next));
  return yyyymm + '-' + ('00' + next).slice(-3);
}

/** Export a spreadsheet (all sheets) as a landscape A4 PDF Blob. */
function _annexHExportPdf(spreadsheetId, fileName) {
  const params = [
    'format=pdf', 'size=A4', 'portrait=false', 'fitw=true',
    'gridlines=false', 'printtitle=false', 'sheetnames=false',
    'top_margin=0.5', 'bottom_margin=0.5', 'left_margin=0.5', 'right_margin=0.5',
  ].join('&');
  const url = 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/export?' + params;
  const response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Annex H PDF export failed: HTTP ' + response.getResponseCode());
  }
  return response.getBlob().setName(fileName);
}

/** Build one Annex H page into `sheet`. */
function _annexHBuildPage(sheet, ctx, pageRows, isLastPage) {
  const N = ANNEX_H_NUMCOLS;
  const widths = [70, 55, 165, 210, 95, 70, 95, 165, 115];
  for (let c = 0; c < N; c++) sheet.setColumnWidth(c + 1, widths[c]);

  // Title.
  sheet.getRange(1, 1, 1, N).merge().setValue(ctx.titleLine1)
    .setFontWeight('bold').setFontSize(12).setHorizontalAlignment('center');
  sheet.getRange(2, 1, 1, N).merge().setValue(ctx.titleLine2)
    .setFontSize(10).setHorizontalAlignment('center');

  // Header fields.
  sheet.getRange(4, 1).setValue('Date:').setFontWeight('bold');
  sheet.getRange(4, 2, 1, 2).merge().setValue(ctx.reportDate);
  sheet.getRange(4, 7).setValue('Report No.:').setFontWeight('bold');
  sheet.getRange(4, 8, 1, 2).merge().setValue(ctx.reportNo);
  sheet.getRange(5, 1).setValue('Bank Name:').setFontWeight('bold');
  sheet.getRange(5, 2, 1, 4).merge().setValue(ctx.bankName);
  sheet.getRange(5, 7).setValue('Sheet No.:').setFontWeight('bold');
  sheet.getRange(5, 8, 1, 2).merge().setValue(ctx.sheetNo + ' of ' + ctx.totalSheets);

  // Column headers (rows 7-8).
  sheet.getRange(7, 1, 1, 3).merge().setValue('e-Payment Details');
  sheet.getRange(8, 1).setValue('Date');
  sheet.getRange(8, 2).setValue('Issuer');
  sheet.getRange(8, 3).setValue('Transaction Reference Number');
  const vmerge = [
    [4, 'Payee'], [5, 'DV/Payroll No.'], [6, 'BUS No.'],
    [7, 'Project Code'], [8, 'Nature of Payment'], [9, 'Amount'],
  ];
  for (let i = 0; i < vmerge.length; i++) {
    sheet.getRange(7, vmerge[i][0], 2, 1).merge().setValue(vmerge[i][1]);
  }
  sheet.getRange(7, 1, 2, N)
    .setFontWeight('bold').setHorizontalAlignment('center')
    .setVerticalAlignment('middle').setWrap(true).setBackground('#D9D9D9');

  // Body.
  let row = 9;
  let pageSum = 0;
  if (pageRows.length > 0) {
    const values = pageRows.map(function (r) {
      pageSum += r.amount;
      return [r.date, r.issuer, r.trn, r.payee, r.dvNo, '', '', r.nature, r.amount];
    });
    sheet.getRange(row, 1, values.length, N).setValues(values).setVerticalAlignment('middle');
    sheet.getRange(row, 9, values.length, 1).setNumberFormat('#,##0.00');
    row += values.length;
  }
  sheet.getRange(7, 1, row - 7, N).setBorder(true, true, true, true, true, true);

  // Page total.
  sheet.getRange(row, 1, 1, 8).merge().setValue('PAGE TOTAL')
    .setFontWeight('bold').setHorizontalAlignment('right');
  sheet.getRange(row, 9).setValue(pageSum).setNumberFormat('#,##0.00').setFontWeight('bold');
  sheet.getRange(row, 1, 1, N).setBorder(true, true, true, true, false, false);
  row += 1;

  // Final page: grand total + certification block.
  if (isLastPage) {
    row += 1;
    sheet.getRange(row, 1, 1, 8).merge().setValue('GRAND TOTAL')
      .setFontWeight('bold').setHorizontalAlignment('right');
    sheet.getRange(row, 9).setValue(ctx.grandTotal).setNumberFormat('#,##0.00')
      .setFontWeight('bold');
    sheet.getRange(row, 1, 1, N).setBorder(true, true, true, true, false, false);
    row += 2;

    sheet.getRange(row, 1, 1, N).merge().setWrap(true).setValue(
      'I HEREBY CERTIFY ON MY OFFICIAL OATH THAT THE ABOVE IS A TRUE STATEMENT OF ALL ' +
      'E-PAYMENTS DURING THE PERIOD STATED ABOVE IN THE AMOUNTS SHOWN THEREON.'
    );
    row += 3;

    if (ctx.signatureFileId) {
      try {
        sheet.insertImage(DriveApp.getFileById(ctx.signatureFileId).getBlob(), 6, row - 1);
      } catch (_e) { /* optional signature — skip on any failure */ }
    }
    sheet.getRange(row, 5, 1, 4).merge().setValue(ctx.officerName)
      .setFontWeight('bold').setHorizontalAlignment('center');
    row += 1;
    sheet.getRange(row, 5, 1, 4).merge()
      .setValue('NAME AND SIGNATURE OF DISBURSING OFFICER / CASHIER / AUTHORIZED OFFICER')
      .setHorizontalAlignment('center').setFontSize(8);
    if (ctx.officerTitle) {
      row += 1;
      sheet.getRange(row, 5, 1, 4).merge().setValue(ctx.officerTitle)
        .setHorizontalAlignment('center').setFontSize(9);
    }
  }
}

/* ----------------------------------------------------------------------
 * Endpoint
 * -------------------------------------------------------------------- */

/**
 * annex_h_generate — Phase 8 (WEBAPP_ENDPOINTS §B.13).
 *
 * Precondition: Status = Notifications Sent. Builds the Annex H PDF
 * from CONFIRMED records only, files it to <batch>/Annex_H_<BatchNo>.pdf,
 * records Annex_H_File_ID + Annex_H_Report_No, Status → Annex H Generated.
 */
function annex_h_generate(args) {
  const session = requireRole(['Maker', 'Admin']);
  if (!args || !args.batch_no) throw new Error('VALIDATION: batch_no required');
  const batchNo = args.batch_no;

  return withBatchLock(batchNo, function () {
    const head = batchHeadRead(batchNo);
    if (!head) throw new Error('STATE: batch ' + batchNo + ' not found');
    if (head.Status !== 'Notifications Sent') {
      throw new Error('STATE: annex_h_generate requires Notifications Sent, got ' + head.Status);
    }

    const items = lineItemsRead(batchNo).items;
    const confirmed = items.filter(function (it) {
      return it.status === 'ACTIVE' && it.bank_status === 'CONFIRMED';
    });
    if (confirmed.length === 0) {
      throw new Error('STATE: batch ' + batchNo + ' has no bank-confirmed records — nothing to report');
    }

    const reportDate = _annexHParseDate(head.Bank_TX_DateTime);
    const reportNo = _annexHReserveReportNo(reportDate.yyyymm);
    const issuer = _emailConfig('annexHIssuer', 'DAP');

    let grandTotal = 0;
    const bodyRows = confirmed.map(function (it) {
      grandTotal += Number(it.amount_php);
      return {
        date: _annexHParseDate(it.bank_confirmed_at || head.Bank_TX_DateTime).iso,
        issuer: issuer,
        trn: it.cm_trn || head.CM_TRN || '',
        payee: it.hris_name_master || '',
        dvNo: head.Batch_No,
        nature: head.Payroll_Type,
        amount: Number(it.amount_php),
      };
    });

    const totalPages = Math.ceil(bodyRows.length / ANNEX_H_ROWS_PER_PAGE);
    const tempSs = SpreadsheetApp.create('__comben_annexh_' + batchNo + '_' + Date.now());
    let pdfFile;
    try {
      const sheets = [tempSs.getSheets()[0]];
      sheets[0].setName('Page 1');
      for (let p = 2; p <= totalPages; p++) sheets.push(tempSs.insertSheet('Page ' + p));

      const ctxBase = {
        titleLine1: 'DAILY REPORT OF E-PAYMENTS FROM AGENCY ACCOUNT',
        titleLine2: '(ANNEX H OF COA CIRCULAR 2021-014)',
        reportDate: reportDate.iso,
        reportNo: reportNo,
        bankName: _emailConfig('annexHBankName', 'Landbank of the Philippines'),
        totalSheets: totalPages + '.0',
        grandTotal: grandTotal,
        officerName: _emailConfig('disbursingOfficerName', 'MARIA MONICA O. TALAN'),
        officerTitle: _emailConfig('disbursingOfficerTitle', ''),
        signatureFileId: _emailConfig('disbursingOfficerSignatureFileId', ''),
      };
      for (let p = 0; p < totalPages; p++) {
        const start = p * ANNEX_H_ROWS_PER_PAGE;
        const ctx = Object.assign({ sheetNo: (p + 1) + '.0' }, ctxBase);
        _annexHBuildPage(
          sheets[p], ctx,
          bodyRows.slice(start, start + ANNEX_H_ROWS_PER_PAGE),
          p === totalPages - 1
        );
      }
      SpreadsheetApp.flush();

      const pdfBlob = _annexHExportPdf(tempSs.getId(), 'Annex_H_' + batchNo + '.pdf');
      const folder = ensureBatchFolder(batchNo);
      const existing = folder.getFilesByName('Annex_H_' + batchNo + '.pdf');
      if (existing.hasNext()) {
        const ts = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss');
        existing.next().setName('Annex_H_' + batchNo + '.bak-' + ts + '.pdf');
      }
      pdfFile = folder.createFile(pdfBlob);
    } finally {
      try { DriveApp.getFileById(tempSs.getId()).setTrashed(true); } catch (_e) {}
    }

    batchHeadUpdate(batchNo, {
      Annex_H_File_ID: pdfFile.getId(),
      Annex_H_Report_No: reportNo,
      Status: 'Annex H Generated',
    });
    audit({
      action: 'ANNEX_H_GENERATED',
      actor: session.email,
      role: session.role,
      targetType: 'BATCH',
      targetId: batchNo,
      before: { Status: 'Notifications Sent' },
      after: {
        Status: 'Annex H Generated',
        annex_h_file_id: pdfFile.getId(),
        annex_h_report_no: reportNo,
        record_count: confirmed.length,
        grand_total: grandTotal,
        pages: totalPages,
      },
    });

    return {
      ok: true,
      batch_no: batchNo,
      status: 'Annex H Generated',
      report_no: reportNo,
      file_id: pdfFile.getId(),
      record_count: confirmed.length,
      grand_total: grandTotal,
      pages: totalPages,
    };
  });
}
