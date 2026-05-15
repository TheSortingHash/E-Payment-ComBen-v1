/**
 * ComBen — ID / account / name normalization (SPEC §10.6, §11).
 *
 * Every read from Payee_Database and every write to FINDES or CM
 * compare passes through these helpers. Input may be a number, a
 * string with stripped leading zeros, or a properly formatted string;
 * output is always the canonical text form.
 */

const HRIS_ID_LEN = 6;
const ACCOUNT_LEN = 10;
const ACCOUNT_SHORT_HARD_STOP = 7;

function padHrisId(value) {
  if (value == null) return '';
  return String(value).trim().padStart(HRIS_ID_LEN, '0');
}

function isValidHrisId(value) {
  if (value == null) return false;
  const s = String(value).trim();
  if (s === '' || s.toUpperCase() === 'N/A') return false;
  return /^\d+$/.test(s) && s.length <= HRIS_ID_LEN;
}

/**
 * Pad a Landbank account number to 10 chars. Throws on suspiciously
 * short values (length ≤ 7), per SPEC §10.4 hard-stop rule.
 *
 * @param {string|number} value
 * @param {string=} ctx  Optional context for the error message (e.g. 'HRIS_ID 205816 ("ABAYA, …")').
 */
function padAccount(value, ctx) {
  if (value == null || String(value).trim() === '') {
    throw new Error('padAccount: empty account' + (ctx ? ' for ' + ctx : ''));
  }
  const s = String(value).trim();
  if (s.length <= ACCOUNT_SHORT_HARD_STOP) {
    throw new Error(
      'Account number ' + (ctx ? 'for ' + ctx + ' ' : '') +
      'is suspiciously short (' + s + '). Verify in Payee_Database before regenerating.'
    );
  }
  return s.padStart(ACCOUNT_LEN, '0');
}

/**
 * Soft-pad: returns the 10-char form without the ≤ 7 hard-stop. For
 * normalization on reads where the caller compares formats but must
 * not raise (CM parser, health-panel anomaly detection).
 */
function normalizeAccount(value) {
  if (value == null) return '';
  return String(value).trim().padStart(ACCOUNT_LEN, '0');
}

/**
 * FINDES payee-name cleaning, verbatim from SPEC §10.6.
 *   - First comma preserved (Landbank's SURNAME / GIVEN_NAMES separator).
 *   - Additional commas, periods, apostrophes, hyphens stripped.
 *   - Ñ → N. Uppercased. Whitespace collapsed.
 *   - Names with no comma: full strip of .,'- (treated as one token).
 */
function cleanPayeeName(payeeName) {
  if (payeeName == null) return '';
  let s = String(payeeName);
  const firstCommaIndex = s.indexOf(',');
  if (firstCommaIndex > -1) {
    const surnamePart = s.substring(0, firstCommaIndex + 1);
    const restOfName  = s.substring(firstCommaIndex + 1);
    s = surnamePart + restOfName.replace(/[.,'-]/g, '');
  } else {
    s = s.replace(/[.,'-]/g, '');
  }
  return s.toUpperCase().replace(/Ñ/g, 'N').replace(/\s+/g, ' ').trim();
}

/**
 * PHP pesos → integer centavos string (SPEC §10.7). No decimal point,
 * no thousands separator. Uses toFixed(0) so the rounding behaviour
 * matches the Treasury writer exactly.
 */
function formatCentavos(amountPhp) {
  const n = Number(amountPhp);
  if (!isFinite(n)) throw new Error('formatCentavos: non-numeric amount ' + amountPhp);
  return (n * 100).toFixed(0);
}
