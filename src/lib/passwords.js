const crypto = require('crypto');

// A temporary password handed to a new HR contact once, on screen, by the
// super admin who created the account. Avoids ambiguous characters (0/O,
// 1/l/I) so it's easy to read back over a call or a form.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generateTempPassword(length = 12) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

module.exports = { generateTempPassword };
