/**
 * ComBen — SHA256 helpers for integrity (SPEC §14.5).
 *
 * LINE_ITEMS_<BatchNo>.json and FINDES_<BatchNo>.csv each carry a
 * SHA256 hash stored on the batch row. Re-verified on every read;
 * mismatch blocks downstream operations and emits an
 * `INTEGRITY_VIOLATION` audit event (SCHEMA §B).
 */

function sha256Hex(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = Utilities.newBlob(input).getBytes();
  } else if (Array.isArray(input)) {
    bytes = input;
  } else if (input && typeof input.getBytes === 'function') {
    bytes = input.getBytes();
  } else {
    throw new Error('sha256Hex: input must be string, byte array, or Blob');
  }
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  let hex = '';
  for (let i = 0; i < digest.length; i++) {
    const b = digest[i] < 0 ? digest[i] + 256 : digest[i];
    const h = b.toString(16);
    hex += (h.length === 1 ? '0' : '') + h;
  }
  return hex;
}

function sha256OfDriveFile(fileId) {
  return sha256Hex(DriveApp.getFileById(fileId).getBlob());
}
