// Short-lived signed tokens for two-step confirmations (refunds).
//
// The confirmation page carries the exact refund the admin reviewed, signed.
// The final POST sends that token, not editable fields, so the amount that
// reaches the backend is exactly the amount shown on the confirm screen —
// and a double-click or a browser back+resubmit can't send it twice (each
// token's nonce is accepted once per session).

const crypto = require('crypto');

function secret() {
  return (
    process.env.SESSION_SECRET ||
    crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev').update('wmt-confirm').digest('hex')
  );
}

function sign(payload, ttlMs = 10 * 60 * 1000) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + ttlMs, nonce: crypto.randomBytes(9).toString('base64url') }),
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'Missing confirmation token.' };
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'Confirmation token is invalid.' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return { ok: false, reason: 'Confirmation token is invalid.' };
  }
  if (Date.now() > payload.exp) return { ok: false, reason: 'This confirmation expired (10 minutes). Start the refund again.' };
  return { ok: true, payload };
}

/**
 * One-time use. Checked in process memory (catches two requests racing from
 * a double-click — the session cookie can't, since both requests arrive
 * carrying the same old cookie) and in the session (survives a redeploy
 * for the same browser).
 */
const seen = new Map(); // nonce -> expiry
function consumeNonce(req, nonce, exp) {
  const now = Date.now();
  for (const [k, v] of seen) if (v < now) seen.delete(k);
  const used = Array.isArray(req.session.usedNonces) ? req.session.usedNonces : [];
  if (seen.has(nonce) || used.includes(nonce)) return false;
  seen.set(nonce, exp || now + 15 * 60 * 1000);
  req.session.usedNonces = [...used, nonce].slice(-20);
  return true;
}

module.exports = { sign, verify, consumeNonce };
