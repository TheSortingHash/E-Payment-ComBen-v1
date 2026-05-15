/**
 * ComBen — Canonical constants.
 *
 * Single source of truth for:
 *   - 23 payroll types (SPEC §0.4)
 *   - State-machine values (SPEC §1)
 *   - Canonical audit action names (SCHEMA §B)
 *   - Default Config rows (SCHEMA §6)
 *   - Default email HTML templates (SPEC §7)
 *
 * Apps Script V8 gotcha: top-level `const` / `let` declarations are
 * scoped to the declaring .gs file and are NOT visible in other files.
 * Only `var` and `function` declarations become true cross-file
 * globals. Every constant below is `var` on purpose so Schema.gs,
 * Audit.gs, Auth.gs, etc. can reference them.
 */

var TZ = 'Asia/Manila'; // UTC+8 year-round. Per SPEC §2.2 datetime fields.

/**
 * 23 payroll types per SPEC §0.4. Order is canonical; row N of this
 * array is row N+1 of the Payroll_Types sheet after seed.
 *
 * Quincena_Mode = YES only for PBP / COS (SPEC §0.5 Mode 2).
 * Hold_Allowed  = YES only for PBP / COS (SPEC §5.1).
 */
var PAYROLL_TYPES = [
  { name: 'RATA',                                code: 'RT',     quincenaMode: false, holdAllowed: false },
  { name: 'Communication Expenses',              code: 'CE',     quincenaMode: false, holdAllowed: false },
  { name: 'Regular Payroll – Plantilla',    code: 'PBP',    quincenaMode: true,  holdAllowed: true  },
  { name: 'Regular Payroll – COS',          code: 'COS',    quincenaMode: true,  holdAllowed: true  },
  { name: 'Monetization',                        code: 'MON',    quincenaMode: false, holdAllowed: false },
  { name: 'Loyalty Pay',                         code: 'LOYA',   quincenaMode: false, holdAllowed: false },
  { name: 'Step Increment Differential',         code: 'SI',     quincenaMode: false, holdAllowed: false },
  { name: 'Promotion Differential',              code: 'PRO',    quincenaMode: false, holdAllowed: false },
  { name: 'RATA OIC',                            code: 'RTOIC',  quincenaMode: false, holdAllowed: false },
  { name: 'Service Charge',                      code: 'SC',     quincenaMode: false, holdAllowed: false },
  { name: 'Mid Year Bonus',                      code: 'MYB',    quincenaMode: false, holdAllowed: false },
  { name: 'Year End Bonus and Cash Gift',        code: 'YEBCG',  quincenaMode: false, holdAllowed: false },
  { name: 'Productivity Enhancement Incentive',  code: 'PEI',    quincenaMode: false, holdAllowed: false },
  { name: 'Service Recognition Incentive',       code: 'SRI',    quincenaMode: false, holdAllowed: false },
  { name: 'Performance Based Bonus',             code: 'PBB',    quincenaMode: false, holdAllowed: false },
  { name: 'Loan Refund',                         code: 'REF',    quincenaMode: false, holdAllowed: false },
  { name: 'Landbank Loan Refund',                code: 'LBP',    quincenaMode: false, holdAllowed: false },
  { name: 'Overtime Payroll – Plantilla',   code: 'PBPOT',  quincenaMode: false, holdAllowed: false },
  { name: 'Overtime Payroll – COS',         code: 'COSOT',  quincenaMode: false, holdAllowed: false },
  { name: 'Differential – COS',             code: 'COSDIF', quincenaMode: false, holdAllowed: false },
  { name: 'Differential – PBP',             code: 'DIFF',   quincenaMode: false, holdAllowed: false },
  { name: 'Gratuity Pay',                        code: 'GRA',    quincenaMode: false, holdAllowed: false },
  { name: 'Token',                               code: 'TOKEN',  quincenaMode: false, holdAllowed: false },
];

var BATCH_STATUSES = [
  'Draft',
  'Pending Approval',
  'Bank Processing',
  'Bank-Confirmed',
  'Notifications Sent',
  'Annex H Generated',
  'Forwarded to Accounting',
  'Closed',
  'Partially Released - Hold Pending',
  'Failed - Bank Mismatch',
  'Cancelled',
];

var HELD_RECORD_STATUSES = ['OPEN', 'RELEASING', 'RELEASED', 'CANCELLED'];

var USER_ROLES = ['Maker', 'Admin', 'Accounting'];
var USER_STATUSES = ['Active', 'Disabled'];

var OUTBOUND_EMAIL_QUEUE_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED'];

var HRIS_PENDING_CHANGE_ACTIONS = ['ADD', 'MODIFY', 'REMOVE'];
var HRIS_PENDING_CHANGE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED'];

var YES_NO = ['YES', 'NO'];

/**
 * Canonical audit action names. SCHEMA §B is the spec; this array is
 * the runtime mirror. Audit.gs validates every emitted action against
 * this list.
 */
var CANONICAL_AUDIT_ACTIONS = [
  'LOGIN_SUCCESS',
  'LOGIN_FAILURE',
  'BATCH_CREATED',
  'BATCH_REVIEW_OPENED',
  'ROW_HELD',
  'ROW_UNHELD',
  'BATCH_SUBMITTED',
  'FINDES_GENERATED',
  'AUTHORIZER_EMAIL_SENT',
  'CM_UPLOADED',
  'CM_EXCEPTION_ACKED',
  'CM_CONFIRMED',
  'NOTIFICATION_QUEUED',
  'NOTIFICATION_SENT',
  'NOTIFICATION_FAILED',
  'ANNEX_H_GENERATED',
  'ACCOUNTING_HANDOFF_SENT',
  'BATCH_CLOSED',
  'SUB_BATCH_CREATED',
  'WEACCESS_UPLOADED',
  'BATCH_CANCELLED',
  'BATCH_NOTIFICATIONS_DRAINED',
  'ENROLLMENT_ADD_AUTO_APPROVED',
  'ENROLLMENT_MODIFY_REQUESTED',
  'ENROLLMENT_REMOVE_REQUESTED',
  'ENROLLMENT_APPROVED',
  'ENROLLMENT_REJECTED',
  'INTEGRITY_VIOLATION',
  'HEAL_LEADING_ZERO',
  'SCHEMA_BOOTSTRAP',
  'SCHEMA_VERIFY',
];

/**
 * DAP palette email header. Navy #1C2790 background, gold #CDAE2C
 * accent bar (SPEC §7). Seeded into Config.emailHeaderHtml so branding
 * edits don't require code changes.
 */
var EMAIL_HEADER_HTML =
  '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1C2790;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">' +
    '<tr>' +
      '<td style="padding:18px 24px;color:#FFFFFF;font-size:18px;font-weight:bold;letter-spacing:0.5px;">' +
        'DEVELOPMENT ACADEMY OF THE PHILIPPINES &mdash; Compensation &amp; Benefits' +
      '</td>' +
    '</tr>' +
    '<tr>' +
      '<td style="height:4px;background:#CDAE2C;line-height:4px;font-size:0;">&nbsp;</td>' +
    '</tr>' +
  '</table>';

var EMAIL_FOOTER_HTML =
  '<div style="margin-top:24px;border-top:3px solid #CDAE2C;padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#666666;">' +
    'This is an automated message from the DAP ComBen E-Payment system. Do not reply to this email.' +
  '</div>';

/**
 * Generic payee notification body template. Admin replaces per type via
 * the Payroll_Types sheet (SCHEMA §3) — same Mustache placeholders.
 */
var DEFAULT_NOTIFICATION_SUBJECT = '[DAP] {{payroll_type}} for {{period}}';
var DEFAULT_NOTIFICATION_BODY =
  '<p>Dear {{payee_name}},</p>' +
  '<p>Your {{payroll_type}} for the period {{period}} has been credited to your Landbank account.</p>' +
  '<p><strong>Amount:</strong> PHP {{amount}}<br>' +
  '<strong>Bank Transaction Reference No.:</strong> {{trn}}<br>' +
  '<strong>Bank Transaction Date/Time:</strong> {{bank_tx_datetime}}</p>' +
  '<p>For questions, please contact the Compensation &amp; Benefits Unit.</p>';

/**
 * Default Config rows per SCHEMA §6 "Bootstrap seed".
 * Inserted only when a key is missing — existing values are NEVER
 * overwritten. The token itself for treasuryBridgeTokenScriptProp
 * is stored in Script Properties, not in this sheet (SPEC §15).
 */
var CONFIG_DEFAULTS = [
  { setting: 'combenDriveRootFolderId',              value: '',                                                                          notes: 'Drive folder ID for the ComBen root tree. Admin fills after creating the folder and sharing with Maker/Admin emails.' },
  { setting: 'archiveFolderId',                      value: '',                                                                          notes: '_archive/ subfolder for cold audit log JSONL exports. Admin fills.' },
  { setting: 'treasuryBridgeUrl',                    value: '',                                                                          notes: 'URL of the Treasury bridge web app (SPEC §15). Admin fills once Treasury deploys.' },
  { setting: 'treasuryBridgeTokenScriptProp',        value: 'TREASURY_BRIDGE_TOKEN',                                                     notes: 'Script Properties key name holding the shared secret. The token itself lives in Script Properties, never in this sheet.' },
  { setting: 'disbursingOfficerName',                value: 'MARIA MONICA O. TALAN',                                                     notes: 'Annex H signatory (SPEC §14.2).' },
  { setting: 'disbursingOfficerTitle',               value: '',                                                                          notes: 'Annex H subtitle. Admin fills with Treasury title.' },
  { setting: 'disbursingOfficerSignatureFileId',     value: '',                                                                          notes: 'Optional. Drive file ID of signature image; inserted above the name line on Annex H (SPEC §16.4).' },
  { setting: 'annexHBankName',                       value: 'Landbank of the Philippines, Pasig Capitol Branch',                         notes: 'Annex H Bank Name field (SPEC §16.2).' },
  { setting: 'annexHIssuer',                         value: 'DAP',                                                                       notes: 'Annex H Issuer field (SPEC §16.3).' },
  { setting: 'accountingRecipients',                 value: 'padillaj@dap.edu.ph, preciadosr@dap.edu.ph, baguim@dap.edu.ph',             notes: 'Phase 9 handoff email recipients (SPEC §7.3). Comma-separated.' },
  { setting: 'adminEmail',                           value: '',                                                                          notes: 'Recipient for CM exception alerts (SPEC §7.4). Admin fills.' },
  { setting: 'emailHeaderHtml',                      value: EMAIL_HEADER_HTML,                                                           notes: 'DAP palette navy #1C2790 header. Editable without code changes.' },
  { setting: 'emailFooterHtml',                      value: EMAIL_FOOTER_HTML,                                                           notes: 'DAP palette gold #CDAE2C accent. Editable without code changes.' },
  { setting: 'notificationTriggerRate',              value: '50',                                                                        notes: 'Emails per minute drained by Phase 7 trigger. Keeps daily volume under Apps Script send caps.' },
  { setting: 'softWarnThresholdPhp',                 value: '100000',                                                                    notes: '6-figure soft-warn threshold for PBP/COS amounts (SPEC §9).' },
  { setting: 'signatureBatch_Letter_RegularPayroll', value: 'A=1st Quincena, B=2nd Quincena',                                            notes: 'Display label for PBP/COS quincena letters (SPEC §0.5 Mode 2).' },
];
