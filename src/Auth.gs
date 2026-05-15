/**
 * ComBen — Authentication and session (WEBAPP_ENDPOINTS §E; SCHEMA §5).
 *
 * Adapted from Treasury's Code.gs:1079 pattern. Two layers of auth:
 *
 *   1. **Google identity** (via Session.getActiveUser().getEmail()) —
 *      assumed to be present when the web app is deployed with domain
 *      restrictions. Anti-impersonation check: the email submitted to
 *      authLogin must match the Google-authenticated user.
 *   2. **In-app password** — SHA256(salt + password) stored in
 *      User_Database. Successful login writes a session token to
 *      CacheService keyed on the email, with a 6-hour TTL (CacheService
 *      max). Every protected endpoint calls requireRole(...) which
 *      reads from CacheService.
 *
 * CacheService is per-script (shared across users), not per-user.
 * Keys are namespaced with `session:` so audit / monitoring entries
 * don't collide.
 */

const SESSION_TTL_SECONDS = 21600; // 6 hours — CacheService maximum.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 10;

/* ----------------------------------------------------------------------
 * Internal helpers (prefixed _auth_ to avoid global-namespace collisions)
 * -------------------------------------------------------------------- */

function _auth_activeUserEmail() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

function _auth_hashPassword(salt, password) {
  return sha256Hex(String(salt) + String(password));
}

function _auth_sessionKey(email) {
  return 'session:' + String(email || '').trim().toLowerCase();
}

function _auth_readSession(email) {
  const raw = CacheService.getScriptCache().get(_auth_sessionKey(email));
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { return null; }
}

function _auth_writeSession(email, role, displayName) {
  const session = {
    email: email,
    role: role,
    display_name: displayName || '',
    issued_at: Date.now(),
  };
  CacheService.getScriptCache().put(
    _auth_sessionKey(email),
    JSON.stringify(session),
    SESSION_TTL_SECONDS
  );
}

function _auth_deleteSession(email) {
  CacheService.getScriptCache().remove(_auth_sessionKey(email));
}

function _auth_lookupUserByEmail(email) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('User_Database');
  if (!sheet) throw new Error('User_Database missing — run setupComBenSchema().');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  const wantEmail = String(email).trim().toLowerCase();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === wantEmail) {
      return {
        rowIndex: i + 2,
        email: data[i][0],
        passwordHash: data[i][1],
        salt: data[i][2],
        role: data[i][3],
        status: data[i][4],
        displayName: data[i][5],
        createdAt: data[i][6],
        lastLoginAt: data[i][7],
      };
    }
  }
  return null;
}

function _auth_updateLastLogin(rowIndex) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('User_Database');
  sheet.getRange(rowIndex, 8).setValue(_now());
}

/* ----------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------- */

/**
 * Validate credentials, set the session, return identity. Throws on
 * failure with a FORBIDDEN-prefixed message; the endpoint layer maps
 * that to the response envelope's `error.code: FORBIDDEN`.
 */
function authLogin(email, password) {
  const submittedEmail = String(email || '').trim();
  if (!EMAIL_RE.test(submittedEmail)) {
    throw new Error('VALIDATION: malformed email.');
  }

  // Anti-impersonation: if Google identity is available, the submitted
  // email must match. (Empty Google email = running from editor /
  // unauthenticated context; skip the check there.)
  const googleEmail = _auth_activeUserEmail();
  if (googleEmail && googleEmail.toLowerCase() !== submittedEmail.toLowerCase()) {
    audit({
      action: 'LOGIN_FAILURE',
      actor: submittedEmail,
      note: 'submitted email does not match Google session (' + googleEmail + ')',
    });
    throw new Error('FORBIDDEN: Email does not match your Google identity.');
  }

  const userRow = _auth_lookupUserByEmail(submittedEmail);
  if (!userRow) {
    audit({ action: 'LOGIN_FAILURE', actor: submittedEmail, note: 'user not found' });
    throw new Error('FORBIDDEN: Invalid credentials.');
  }
  if (userRow.status !== 'Active') {
    audit({
      action: 'LOGIN_FAILURE',
      actor: submittedEmail,
      role: userRow.role,
      note: 'account ' + userRow.status,
    });
    throw new Error('FORBIDDEN: Account ' + userRow.status + '.');
  }

  const computed = _auth_hashPassword(userRow.salt, password);
  if (computed !== userRow.passwordHash) {
    audit({
      action: 'LOGIN_FAILURE',
      actor: submittedEmail,
      role: userRow.role,
      note: 'bad password',
    });
    throw new Error('FORBIDDEN: Invalid credentials.');
  }

  _auth_writeSession(submittedEmail, userRow.role, userRow.displayName);
  _auth_updateLastLogin(userRow.rowIndex);
  audit({
    action: 'LOGIN_SUCCESS',
    actor: submittedEmail,
    role: userRow.role,
  });

  return {
    email: submittedEmail,
    role: userRow.role,
    display_name: userRow.displayName,
  };
}

function authLogout() {
  const email = _auth_activeUserEmail();
  if (email) _auth_deleteSession(email);
  return { ok: true };
}

/**
 * Returns the current session identity, or null if not logged in /
 * session expired. Cheap — single CacheService read.
 */
function authWhoami() {
  const email = _auth_activeUserEmail();
  if (!email) return null;
  const session = _auth_readSession(email);
  if (!session) return null;
  return {
    email: session.email,
    role: session.role,
    display_name: session.display_name,
  };
}

/**
 * Server-side role gate. Call at the start of every mutating
 * endpoint. Throws FORBIDDEN if not logged in or role not allowed.
 *
 * @param {string|string[]} allowed  Single role or array of roles.
 * @return {object}                  The session, for the caller to
 *                                   read email / display_name from.
 */
function requireRole(allowed) {
  const session = authWhoami();
  if (!session) throw new Error('FORBIDDEN: Not logged in.');
  const list = Array.isArray(allowed) ? allowed : [allowed];
  if (list.indexOf(session.role) === -1) {
    throw new Error(
      'FORBIDDEN: requires role ' + list.join(' or ') +
      ', got ' + session.role + '.'
    );
  }
  return session;
}

/* ----------------------------------------------------------------------
 * Bootstrap helper
 * -------------------------------------------------------------------- */

/**
 * Create the first system user. Run from the Apps Script editor once
 * after setupComBenSchema and before publishing the web app.
 *
 * WARNING: the password is in the function-call arguments, which the
 * Apps Script execution log captures in cleartext. Use a one-time
 * throwaway and have the user change it immediately. (v1 has no
 * force-change-password flow; admins edit User_Database directly via
 * a future Slice 13 admin endpoint.)
 *
 * @example
 *   createUser('admin@dap.edu.ph', 'TempPassword123!', 'Admin', 'Admin User');
 *   createUser('maker@dap.edu.ph', 'TempPassword456!', 'Maker', 'Maker User');
 */
function createUser(email, password, role, displayName) {
  const e = String(email || '').trim();
  if (!EMAIL_RE.test(e)) throw new Error('createUser: malformed email.');
  if (String(password || '').length < MIN_PASSWORD_LEN) {
    throw new Error('createUser: password must be at least ' + MIN_PASSWORD_LEN + ' characters.');
  }
  if (USER_ROLES.indexOf(role) === -1) {
    throw new Error('createUser: unknown role "' + role + '". Allowed: ' + USER_ROLES.join(', '));
  }
  if (_auth_lookupUserByEmail(e)) {
    throw new Error('createUser: user ' + e + ' already exists.');
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('User_Database');
  if (!sheet) throw new Error('Run setupComBenSchema() first.');
  const salt = Utilities.getUuid();
  const hash = _auth_hashPassword(salt, password);
  sheet.appendRow([
    e,
    hash,
    salt,
    role,
    'Active',
    displayName || e,
    _now(),
    '', // Last_Login_At
  ]);
  return { ok: true, email: e, role: role };
}
